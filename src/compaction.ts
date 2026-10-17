// jev - System One based conversation compaction, following
// https://github.com/tamaratran/fast-jev-compaction (a Claude Code plugin /
// npm library), ported to OpenCode v2's plugin compaction hook.
//
// Same approach as the reference:
//
//   - user/assistant text is never rewritten; only tool calls and their
//     results are candidates, paired by id; calls in the first message or
//     in the newest `preserveRecentMessages` messages are pinned
//   - the state sent to Jev is the whole transcript, oldest first, with
//     every tool result replaced by a short size note (`ok, 4213 chars
//     (omitted)`) - inputs are included, nothing is summarized; the state
//     is regex-scrubbed first, so secrets never reach Jev
//   - the state is fitted into `maxStateTokens` in stages: tool inputs
//     truncated to 1000/200/60 chars, oldest non-pinned texts abridged,
//     old message texts collapsed, old calls reduced to one line each,
//     old call-less messages left out, runs of old call-only messages
//     folded into one entry each
//   - every non-pinned call gets two `noul` questions: should the call
//     stay (made + input still matters), should the RESULT stay verbatim
//     (contents still needed, re-running would not do); questions are
//     batched so state + questions fit `maxRequestTokens`, batches run
//     concurrently and share the same full state
//   - decisions: result >= keepThreshold -> keep both; else call >=
//     keepThreshold -> keep call, truncate result to `truncateHeadChars`
//     plus a note; else drop call and result together
//   - fail-closed: Jev failures, malformed answers, a missing key, or a
//     history that cannot be fitted throw, and the built-in compaction
//     runs on an UNMODIFIED transcript - the reference's fallback to
//     Claude Code's built-in summary
//
// OpenCode adaptation:
//
//   - `session.hook("compaction")` receives the older transcript that the
//     built-in summarizer would see (core already excludes the newest
//     `keep` tokens), as LLM messages: tool calls and results are parts of
//     assistant messages, paired by part id
//   - mode "replace" (default; the reference behavior): when pruning is
//     large enough (reduction + summary-size guards), the hook SUPPLIES
//     `event.result` - the pruned transcript rendered verbatim - so no
//     summarizer model call happens at all and everything kept stays
//     verbatim
//   - otherwise (insufficient reduction, oversized summary, or mode
//     "clean"): the decisions are applied to `event.messages` in place and
//     the built-in summarizer runs over the cleaned transcript
//   - hook-supplied summaries report the real jev token usage (the row's
//     "N in · N out" title line); the host derives the cost entry from the
//     compaction model's price table - the jev call itself bills on the jev
//     model, so that cost line is a documented approximation

// ---------------------------------------------------------------------------
// Types (structural - matches @opencode/ai message parts at runtime)
// ---------------------------------------------------------------------------

export interface Options {
  keepThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
  /** Minimum relative drop (in chars) before a hook-supplied summary may replace the built-in one. */
  minReduction: number
  /** Cap on the hook-supplied summary in estimated tokens; defaults to half the model's context window. */
  maxSummaryTokens?: number
  /** "replace" (default): supply the pruned transcript as the compaction summary. "clean": only rewrite messages, let the built-in summarizer run. */
  mode?: "replace" | "clean"
  /**
   * Shape of the hook-supplied summary in `replace` mode. "report" (default)
   * keeps the summary itself tiny - a per-call report of what was judged
   * (dropped / truncated / kept with a bounded head) - so the compaction block
   * reads like an audit trail and carries the least context. The older
   * user/assistant exchanges are NOT replayed into the summary at all; only
   * the host-kept `recent` conversation and this report describe the past.
   * "transcript" opts back into replaying user/assistant text verbatim with
   * tool calls and results per Jev's verdicts.
   */
  summary?: "transcript" | "report"
}

export const DEFAULTS: Options = {
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  minReduction: 0.25,
}

const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file."

/** Successive caps on the serialized tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const
const TEXT_HEAD = 400
const TEXT_TAIL = 150

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20

export interface LLMMessage {
  id?: string
  role: string
  content: Array<any>
  metadata?: Record<string, unknown>
  providerMetadata?: unknown
  native?: unknown
}

export interface HookEvent {
  messages: Array<LLMMessage>
  result?: { summary: string }
  model?: { providerID?: string; id?: string }
}

export type Judge = (
  questions: Array<{
    id: string
    type: "noul" | "choice" | "score"
    instructions: string
    criteria?: Record<string, string>
  }>,
  state: unknown,
  signal?: AbortSignal,
) => Promise<{ answers?: Record<string, any>; usage?: { input_tokens?: number; output_tokens?: number } }>

export type SecretPattern = [RegExp, string]

export interface Stats {
  messagesBefore: number
  messagesAfter: number
  charsBefore: number
  charsAfter: number
  calls: number
  pinned: number
  kept: number
  resultsDropped: number
  callsDropped: number
  stateTokens: number
  stateStage: string
  requests: number
  inputTokens: number
  outputTokens: number
  ms: number
}

export interface Plan {
  /** Hook-supplied summary (replace mode), when the guards allow it. */
  replaceSummary?: string
  /** Pruned transcript for in-place application (clean mode / replace fallback). */
  keepMessages?: LLMMessage[]
  stats: Stats
  summaryTokens?: number
  /**
   * Real token usage the jev judgment batches consumed. The host shows these in
   * the compaction row ("N in · N out", parity with the built-in summarizer) and
   * derives a cost entry from the compaction model's price table - documented
   * because the actual jev call bills on the jev model.
   */
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

// ---------------------------------------------------------------------------
// Token estimation (no tokenizer; like the reference it lands a little above
// the counts Jev reports)
// ---------------------------------------------------------------------------

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6)
    } else tokens += 0.9
  }
  return Math.ceil(tokens)
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function resultTextOf(result: any): string {
  if (!result || typeof result !== "object") return ""
  switch (result.type) {
    case "text":
      return typeof result.value === "string" ? result.value : String(result.value)
    case "content":
      if (!Array.isArray(result.value)) return ""
      return result.value
        .map((part: any) => {
          if (!part || typeof part !== "object") return ""
          if (part.type === "text") return String(part.text ?? "")
          if (part.type === "file") return `[file output: ${part.name ?? part.mime ?? "binary"}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
    case "json":
    case "error": {
      try {
        return JSON.stringify(result.value) ?? ""
      } catch {
        return ""
      }
    }
    default:
      return ""
  }
}

function messageText(message: LLMMessage): string {
  const texts: string[] = []
  for (const part of message.content ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text)
    else if (part.type === "media") texts.push(`[attachment ${part.filename ?? "omitted"}]`)
  }
  return texts.join("\n")
}

/** Characters of text, tool input and tool output one message holds. */
export function messageChars(message: LLMMessage): number {
  let total = 0
  for (const part of message.content ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text") total += String(part.text ?? "").length
    if (part.type === "tool-call") {
      try {
        total += JSON.stringify(part.input ?? {}).length
      } catch {
        total += 20
      }
    }
    if (part.type === "tool-result") total += resultTextOf(part.result).length
  }
  return total
}

// ---------------------------------------------------------------------------
// Call collection (tool-call parts paired with tool-result parts by id)
// ---------------------------------------------------------------------------

export interface Call {
  key: string
  name: string
  input: unknown
  callMsg: number
  callIndex: number
  resultMsg: number
  resultIndex: number
  resultText: string
  resultChars: number
  isError: boolean
  pinned: boolean
}

export function collectCalls(
  messages: ReadonlyArray<LLMMessage>,
  preserveRecentMessages: number,
): Call[] {
  const results = new Map<string, { msg: number; index: number; part: any }>()
  messages.forEach((message, msg) => {
    // Host-injected system blocks (Code Mode catalog updates) are excluded
    // everywhere: their calls must never be judged, pruned or reported.
    if (message.role === "system") return
    message.content?.forEach((part: any, index: number) => {
      if (part && part.type === "tool-result" && typeof part.id === "string") {
        results.set(part.id, { msg, index, part })
      }
    })
  })

  const pinned = (index: number) => index === 0 || index >= messages.length - preserveRecentMessages

  const calls: Call[] = []
  messages.forEach((message, callMsg) => {
    if (message.role === "system") return
    message.content?.forEach((part: any, callIndex: number) => {
      if (!part || part.type !== "tool-call" || typeof part.id !== "string") return
      const found = results.get(part.id)
      if (!found) return
      const text = resultTextOf(found.part.result)
      calls.push({
        key: `t${calls.length + 1}`,
        name: String(part.name ?? "tool"),
        input: part.input,
        callMsg,
        callIndex,
        resultMsg: found.msg,
        resultIndex: found.index,
        resultText: text,
        resultChars: text.length,
        isError: found.part.result?.type === "error",
        pinned: pinned(callMsg) || pinned(found.msg),
      })
    })
  })
  return calls
}

// ---------------------------------------------------------------------------
// State fitting (staged, like the reference)
// ---------------------------------------------------------------------------

interface ToolCallEntry {
  id: string
  tool: string
  input: string
  result: string
}

interface HistoryEntry {
  i: number
  role: string
  text: string
  tool_calls?: ToolCallEntry[] | string[]
}

function inputText(input: unknown, limit: number): string {
  let json = ""
  try {
    json = JSON.stringify(input)
  } catch {
    json = "[unserializable input]"
  }
  return truncate(json, limit)
}

function resultNote(call: Call): string {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: Call): string {
  const input = Object.entries((call.input ?? {}) as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value)
      return `${key}=${text.replace(/\s+/g, " ")}`
    })
    .join(" ")
  return `${call.key} ${truncate(call.name, 40)} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? "error" : "ok"
  } ${call.resultChars}ch`
}

function callsByCallMsg(calls: ReadonlyArray<Call>): Map<number, Call[]> {
  const byMessage = new Map<number, Call[]>()
  for (const call of calls) {
    const list = byMessage.get(call.callMsg) ?? []
    list.push(call)
    byMessage.set(call.callMsg, list)
  }
  return byMessage
}

function historyEntries(
  messages: ReadonlyArray<LLMMessage>,
  calls: ReadonlyArray<Call>,
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByCallMsg(calls)
  const entries: HistoryEntry[] = []
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.key,
      tool: truncate(call.name, 40),
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }))
    const text = messageText(message)
    if (text.trim().length === 0 && toolCalls.length === 0) return
    const entry: HistoryEntry = { i, role: message.role, text }
    if (toolCalls.length > 0) entry.tool_calls = toolCalls
    entries.push(entry)
  })
  return entries
}

/** The last three real user prompts, as the default `goal`. */
function goalFromMessages(messages: ReadonlyArray<LLMMessage>, calls: ReadonlyArray<Call>): string {
  const withCalls = new Set(calls.map((call) => call.callMsg))
  return messages
    .filter(
      (message, index) =>
        message.role === "user" && !withCalls.has(index) && messageText(message).trim().length > 0,
    )
    .slice(-3)
    .map((message) => truncate(messageText(message), 500))
    .join("\n")
}

interface FittedState {
  state: { context: string; goal: string; history: HistoryEntry[] }
  tokens: number
  stage: string
}

function fitState(
  messages: ReadonlyArray<LLMMessage>,
  calls: ReadonlyArray<Call>,
  options: Pick<Options, "maxStateTokens" | "preserveRecentMessages">,
): FittedState {
  // Host-injected system blocks (Code Mode tool-catalog updates and friends)
  // are regenerated by the host every turn; judging them only burns tokens.
  const historyMessages = messages.filter((message) => message.role !== "system")
  const goal = goalFromMessages(historyMessages, calls)
  const stateOf = (history: HistoryEntry[]) => ({ context: STATE_CONTEXT, goal, history })
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])))

  let history: HistoryEntry[] = []
  let perEntry: number[] = []
  let tokens = 0
  const rebuild = (inputChars: number): void => {
    history = historyEntries(historyMessages, calls, inputChars)
    perEntry = history.map(entryTokens)
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  }
  const fits = (): boolean => tokens <= options.maxStateTokens
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index]
    if (entry === undefined) return
    change(entry)
    const now = entryTokens(entry)
    tokens += now - (perEntry[index] ?? 0)
    perEntry[index] = now
  }

  rebuild(INPUT_CHARS[0])
  if (fits()) return { state: stateOf(history), tokens, stage: "full" }

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit)
    if (fits()) return { state: stateOf(history), tokens, stage: `inputs<=${limit}` }
  }

  const pinned = (entry: HistoryEntry): boolean =>
    entry.i === 0 || entry.i >= messages.length - options.preserveRecentMessages
  const indices = history.map((_, index) => index)
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ]

  for (const index of order) {
    const entry = history[index]!
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL)
    })
    if (fits()) return { state: stateOf(history), tokens, stage: "texts abridged" }
  }

  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.text.length === 0) continue
    const len = entry.text.length
    shrink(index, (e) => {
      e.text = `[… ${len} chars omitted …]`
    })
    if (fits()) return { state: stateOf(history), tokens, stage: "old messages collapsed" }
  }

  const byMessage = callsByCallMsg(calls)
  for (const index of order) {
    const entry = history[index]!
    const own = byMessage.get(entry.i)
    if (pinned(entry) || !own) continue
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall)
    })
    if (fits()) return { state: stateOf(history), tokens, stage: "old calls compacted" }
  }

  const left = new Set<number>()
  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.tool_calls) continue
    left.add(index)
    tokens -= perEntry[index] ?? 0
    if (fits()) {
      return { state: stateOf(history.filter((_, i) => !left.has(i))), tokens, stage: "old messages left out" }
    }
  }

  // Fold runs of adjacent old call-only entries into one entry each, so the
  // per-entry envelope is paid once per run; the call lines keep their ids.
  const survivors = history.filter((_, i) => !left.has(i))
  const merged: HistoryEntry[] = []
  for (const entry of survivors) {
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && Array.isArray(e.tool_calls) && typeof e.tool_calls[0] === "string"
    const previous = merged[merged.length - 1]
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])]
      continue
    }
    merged.push({ ...entry })
  }
  perEntry = merged.map(entryTokens)
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  if (fits()) return { state: stateOf(merged), tokens, stage: "old calls merged" }

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  )
}

// ---------------------------------------------------------------------------
// Questions, batching, decisions
// ---------------------------------------------------------------------------

function questionsFor(call: Call) {
  return [
    {
      id: `call_${call.key}`,
      type: "noul" as const,
      instructions: `Tool call ${call.key} (${call.name}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    {
      id: `result_${call.key}`,
      type: "noul" as const,
      instructions: `The full output of tool call ${call.key} (${call.name}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  ]
}

function batchCalls(
  calls: ReadonlyArray<Call>,
  stateTokens: number,
  options: Pick<Options, "maxRequestTokens">,
): Call[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS
  const batches: Call[][] = []
  let current: Call[] = []
  let currentTokens = 0
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)))
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(`state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`)
    }
    current.push(call)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

type Action = "keep" | "drop_result" | "drop_call"

interface Decision {
  call: Call
  keepCall: number
  keepResult: number
  action: Action
  reason: "kept" | "result_dropped" | "call_dropped"
}

interface Answer {
  keepCall: number
  keepResult: number
}

function decideCall(call: Call, answer: Answer | undefined, threshold: number): Decision {
  const keepCall = answer?.keepCall ?? Number.NaN
  const keepResult = answer?.keepResult ?? Number.NaN
  const base = { call, keepCall, keepResult }
  if (keepResult >= threshold) return { ...base, action: "keep", reason: "kept" }
  if (keepCall >= threshold) return { ...base, action: "drop_result", reason: "result_dropped" }
  return { ...base, action: "drop_call", reason: "call_dropped" }
}

async function askBatch(
  judge: Judge,
  state: unknown,
  batch: ReadonlyArray<Call>,
): Promise<{ answers: Map<string, Answer>; usage: { input_tokens?: number; output_tokens?: number } }> {
  const questions = batch.flatMap(questionsFor)
  const reply = await judge(questions, state)
  const answers = reply.answers
  const out = new Map<string, Answer>()
  for (const call of batch) {
    const keepCallN = (answers as any)?.[`call_${call.key}`]?.noul
    const keepResultN = (answers as any)?.[`result_${call.key}`]?.noul
    if (typeof keepCallN !== "number" || !Number.isFinite(keepCallN)) {
      throw new Error(`Malformed or missing Jev answer for ${call.key} (call)`)
    }
    if (typeof keepResultN !== "number" || !Number.isFinite(keepResultN)) {
      throw new Error(`Malformed or missing Jev answer for ${call.key} (result)`)
    }
    out.set(call.key, { keepCall: keepCallN, keepResult: keepResultN })
  }
  return { answers: out, usage: reply.usage ?? {} }
}

/** Deterministic regex scrub of the state (rule: secrets never reach Jev via any path). */
export function scrubState(
  value: unknown,
  patterns: ReadonlyArray<SecretPattern>,
): { value: unknown; hits: number } {
  if (typeof value === "string") {
    let out = value
    let hits = 0
    for (const [pattern, label] of patterns) {
      out = out.replace(pattern, () => {
        hits++
        return `[REDACTED:${label}]`
      })
    }
    return { value: out, hits }
  }
  if (Array.isArray(value)) {
    let hits = 0
    const items = value.map((item) => {
      const scrubbed = scrubState(item, patterns)
      hits += scrubbed.hits
      return scrubbed.value
    })
    return { value: items, hits }
  }
  if (value && typeof value === "object") {
    let hits = 0
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = scrubState(item, patterns)
      hits += scrubbed.hits
      out[key] = scrubbed.value
    }
    return { value: out, hits }
  }
  return { value, hits: 0 }
}

// ---------------------------------------------------------------------------
// Application 1: rebuild messages from the decisions (clean mode / fallback)
// ---------------------------------------------------------------------------

function truncatedResult(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[jev compaction dropped ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`
}

function truncatedResultValue(part: any, headChars: number): unknown {
  const text = truncatedResult(resultTextOf(part.result), part.result?.type === "error", headChars)
  // Keep error results in the error envelope so provider adapters keep the flag.
  return part.result?.type === "error" ? { type: "error", value: text } : { type: "text", value: text }
}

/** Rebuilds the transcript from the decisions; untouched messages are returned as the same objects. */
export function applyDecisions(
  messages: ReadonlyArray<LLMMessage>,
  decisions: ReadonlyMap<string, Decision>,
  headChars: number,
): LLMMessage[] {
  // Tool-call parts of dropped calls and their (possibly cross-message)
  // results disappear together; nothing is ever left without its call.
  const actions = new Map<string, Action>()
  for (const decision of decisions.values()) {
    if (decision.action === "keep") continue
    const c = decision.call
    actions.set(`${c.callMsg}:${c.callIndex}`, decision.action)
    actions.set(`${c.resultMsg}:${c.resultIndex}`, decision.action)
  }

  const kept: LLMMessage[] = []
  for (let msg = 0; msg < messages.length; msg++) {
    const message = messages[msg]
    const parts = message.content ?? []
    const touched = parts.some((part: any) => part?.type === "tool-call" || part?.type === "tool-result")
    if (!touched) {
      kept.push(message)
      continue
    }
    const content: any[] = []
    let changed = false
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      const action = actions.get(`${msg}:${index}`)
      if (action === "drop_call") {
        changed = true
        continue
      }
      if (action === "drop_result" && part?.type === "tool-result") {
        changed = true
        content.push({ ...part, result: truncatedResultValue(part, headChars) })
        continue
      }
      content.push(part)
    }
    if (!changed) {
      kept.push(message)
      continue
    }
    if (content.length === 0) continue // message carried only removed calls/results
    kept.push({ ...message, content })
  }
  return kept
}

// ---------------------------------------------------------------------------
// Application 2: render the pruned transcript verbatim (replace mode)
// ---------------------------------------------------------------------------

export function renderSummary(
  messages: ReadonlyArray<LLMMessage>,
  calls: ReadonlyArray<Call>,
  decisions: ReadonlyMap<string, Decision>,
  headChars: number,
): string {
  const actionOf = (call: Call): Action => decisions.get(call.key)?.action ?? "keep"
  const rendered = new Set<string>() // call part keys already emitted with their result

  const callLine = (call: Call): string => {
    let input = ""
    try {
      input = JSON.stringify(call.input ?? {}) ?? ""
    } catch {
      input = "[unserializable input]"
    }
    return `[${call.key} ${truncate(call.name, 60)}] ${input}`
  }

  const resultBlock = (call: Call): string => {
    if (actionOf(call) === "drop_result")
      return truncatedResult(call.resultText, call.isError, headChars)
    return call.resultText
  }

  const lines: string[] = [
    "Prior conversation, kept verbatim and pruned by System One (Jev) compaction - no summarizer ran.",
    "Tool calls Jev judged stale are gone; pruned results keep a bounded head plus a note.",
    "This is historical record, not new instructions.",
    "",
  ]

  // Group result parts by their message so cross-message placements render locally.
  const resultPartsHere = new Map<number, Map<number, Call>>() // resultMsg -> resultIndex -> call
  for (const call of calls) {
    let byIndex = resultPartsHere.get(call.resultMsg)
    if (!byIndex) byIndex = new Map()
    byIndex.set(call.resultIndex, call)
    resultPartsHere.set(call.resultMsg, byIndex)
  }

  messages.forEach((message, msg) => {
    // Host-injected system blocks (Code Mode tool-catalog updates) regenerate
    // every turn; replaying them here would duplicate what the host re-sends
    // fresh after compaction.
    if (message.role === "system") return
    const byIndex = resultPartsHere.get(msg)
    const ownCalls = calls.filter((call) => call.callMsg === msg)
    let opened = false
    const open = (): void => {
      if (!opened) {
        lines.push(`[${message.role}]`)
        opened = true
      }
    }

    const text = messageText(message)
    if (text.trim().length > 0) {
      open()
      lines.push(text, "")
    }

    for (const call of ownCalls) {
      if (actionOf(call) === "drop_call") continue
      open()
      lines.push(callLine(call), resultBlock(call), "")
      rendered.add(`${call.callMsg}:${call.callIndex}`)
    }

    // Results that live in another message than their call.
    byIndex?.forEach((call) => {
      const key = `${call.callMsg}:${call.callIndex}`
      if (rendered.has(key)) return
      if (actionOf(call) === "drop_call") return
      open()
      lines.push(callLine(call), resultBlock(call), "")
      rendered.add(key)
    })

    // Result parts without any matching call pass through verbatim.
    message.content?.forEach((part: any, index: number) => {
      if (!part || part.type !== "tool-result") return
      if (calls.some((c) => c.resultMsg === msg && c.resultIndex === index)) return
      const text = resultTextOf(part.result)
      if (!text) return
      open()
      lines.push(text, "")
    })
  })

  return lines.join("\n").trimEnd()
}

// ---------------------------------------------------------------------------
// Application 2b: compact per-call report (summary: "report" mode)
// ---------------------------------------------------------------------------

/**
 * A tiny audit-trail summary: counts only - no inputs, no per-call list, no
 * user/assistant replay. Pinned calls (the newest window - also the host's
 * verbatim `recent` context) are excluded so they are never described twice.
 */
export function renderCallReport(
  calls: ReadonlyArray<Call>,
  decisions: ReadonlyMap<string, Decision>,
): string {
  const judged = calls.filter((call) => !call.pinned && decisions.has(call.key))
  const judgedOnly = calls.filter((call) => !call.pinned && !decisions.has(call.key))

  let dropped = 0
  let keptHeads = 0
  const droppedKinds = new Map<string, number>()
  for (const call of judged) {
    const verdict = decisions.get(call.key)
    if (!verdict) continue
    if (verdict.action === "drop_call") {
      dropped += 1
      droppedKinds.set(call.name, (droppedKinds.get(call.name) ?? 0) + 1)
    } else {
      keptHeads += 1
    }
  }

  const lines: string[] = [
    "Older history was removed by System One (Jev) compaction.",
    `- ${dropped} of ${judged.length} judged tool calls dropped (call+result); ${keptHeads} kept with a bounded head.`,
    `- ${judgedOnly.length} newer/pinned tool calls are part of the verbatim recent context.`,
    "Older user/assistant text is not replayed; re-run a call if its result is needed again.",
  ]
  if (droppedKinds.size > 0) {
    const kinds = [...droppedKinds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name} ${count}`)
    lines.push(`- Dropped tool types: ${kinds.join(", ")}.`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// The pipeline (throws on any failure; the hook decides the fallback)
// ---------------------------------------------------------------------------

/** Runs the fast-jev pass over the hook's transcript. */
export async function runCompaction(
  messages: ReadonlyArray<LLMMessage>,
  judge: Judge,
  patterns: ReadonlyArray<SecretPattern>,
  options: Options,
  windowOf: () => number,
): Promise<Plan> {
  const started = Date.now()
  const stats: Stats = {
    messagesBefore: messages.length,
    messagesAfter: messages.length,
    charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
    charsAfter: 0,
    calls: 0,
    pinned: 0,
    kept: 0,
    resultsDropped: 0,
    callsDropped: 0,
    stateTokens: 0,
    stateStage: "",
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
  }

  if (messages.length === 0) return { stats }

  const calls = collectCalls(messages, options.preserveRecentMessages)
  stats.calls = calls.length
  const candidates = calls.filter((call) => !call.pinned)
  stats.pinned = calls.length - candidates.length
  if (candidates.length === 0) {
    stats.charsAfter = stats.charsBefore
    return { stats }
  }

  const fitted = fitState(messages, calls, options)
  stats.stateTokens = fitted.tokens
  stats.stateStage = fitted.stage
  const batches = batchCalls(candidates, fitted.tokens, options)
  stats.requests = batches.length
  const scrubbed = scrubState(fitted.state, patterns)

  const decisions = new Map<string, Decision>()
  const settled = await Promise.all(
    batches.map(async (batch) => {
      const request = await askBatch(judge, scrubbed.value, batch)
      stats.inputTokens += request.usage.input_tokens ?? 0
      stats.outputTokens += request.usage.output_tokens ?? 0
      return { batch, answers: request.answers }
    }),
  )
  for (const { batch, answers } of settled) {
    for (const call of batch) {
      decisions.set(call.key, decideCall(call, answers.get(call.key), options.keepThreshold))
    }
  }
  for (const decision of decisions.values()) {
    if (decision.reason === "kept") stats.kept++
    else if (decision.reason === "result_dropped") stats.resultsDropped++
    else stats.callsDropped++
  }

  const applied = applyDecisions(messages, decisions, options.truncateHeadChars)
  stats.messagesAfter = applied.length
  stats.charsAfter = applied.reduce((sum, message) => sum + messageChars(message), 0)
  stats.ms = Date.now() - started

  console.log(
    `[jev] compaction judged: candidates=${candidates.length} kept=${stats.kept} result_dropped=${stats.resultsDropped} ` +
      `call_dropped=${stats.callsDropped} (pinned=${stats.pinned}) state=${fitted.tokens}tok/${fitted.stage} ` +
      `requests=${batches.length} usage(in/out)=${stats.inputTokens}/${stats.outputTokens} redactions=${scrubbed.hits} ` +
      `${stats.ms}ms`,
  )

  const plan: Plan = { stats }
  if (stats.requests > 0) {
    plan.tokens = {
      input: stats.inputTokens,
      output: stats.outputTokens,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
  }
  if (options.mode !== "clean") {
    const reduction = stats.charsBefore === 0 ? 0 : (stats.charsBefore - stats.charsAfter) / stats.charsBefore
    if (reduction >= options.minReduction) {
      const base =
        options.summary === "report"
          ? renderCallReport(calls, decisions)
          : renderSummary(messages, calls, decisions, options.truncateHeadChars)
      const summary = `${base}\n\n(Compaction pass by jev. Run /compact again within one minute of a previous one to get OpenCode's built-in summarizer instead.)`
      const tokens = estimateTokens(summary)
      const cap = options.maxSummaryTokens ?? Math.floor(windowOf() / 2)
      if (tokens <= cap) {
        plan.replaceSummary = summary
        plan.summaryTokens = tokens
        return plan
      }
      console.log(
        `[jev] compaction: summary ~${tokens}tok exceeds cap ~${cap}tok - applying decisions and letting the built-in summarizer run`,
      )
    }
  }
  plan.keepMessages = applied
  return plan
}
