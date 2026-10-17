// Pure decision helpers for the jev plugin's newer features.
//
// Everything here is importable from tests without a plugin host or a Jev
// endpoint: only node builtins, no side effects, no @opencode/plugin import.
// src/index.ts wires these into hooks, tools and commands; src/find.ts builds
// the search cascade on top of them.

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Shared question shape (structurally compatible with index.ts's Question)
// ---------------------------------------------------------------------------

export interface QuestionLike {
  id: string
  type: string
  instructions: string
  criteria?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Reasoning-effort levels (used by auto effort and the routing pair question)
// ---------------------------------------------------------------------------

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export const EFFORT_CRITERIA: Record<string, string> = {
  none: "No reasoning needed: a trivial lookup, formatting, one-line edit, or a follow-up with an obvious next action",
  minimal:
    "Barely any reasoning: an explicit, unambiguous instruction with a directly known answer",
  low: "Light reasoning: a clear, bounded task with an obvious next action and no open design questions",
  medium:
    "Normal multi-step work: several files or steps, some uncertainty, moderate planning - the typical coding request",
  high: "Hard work: complex debugging, architecture or interface design, broad refactors, or unfamiliar territory needing careful analysis",
  xhigh: "Very hard: deep multi-system reasoning where getting it wrong is costly",
  max: "Maximum thinking: the hardest problems with the highest stakes",
}

const levelCriteria = (level: string): string => EFFORT_CRITERIA[level] ?? level

// ---------------------------------------------------------------------------
// Model routing: jev picks (model, effort level) per prompt - one decision
// over one option list per turn; the caller applies switches and pins.
// ---------------------------------------------------------------------------

export interface Candidate {
  providerID: string
  modelID: string
  /** Optional human hint that rides into the option criteria ("cheap workhorse"). */
  label?: string
}

// Accepts "provider/model" strings or {providerID, modelID, label?} objects.
// A string's FIRST slash separates provider from model id: providers never
// contain "/", model ids may (e.g. openrouter/anthropic/claude-x).
export function parseCandidates(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) return []
  const out: Candidate[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      const slash = entry.indexOf("/")
      if (slash <= 0) continue
      const providerID = entry.slice(0, slash).trim()
      const modelID = entry.slice(slash + 1).trim()
      if (!providerID || !modelID) continue
      out.push({ providerID, modelID })
    } else if (entry && typeof entry === "object") {
      const c = entry as Record<string, any>
      if (typeof c.providerID === "string" && c.providerID.trim() && typeof c.modelID === "string" && c.modelID.trim())
        out.push({
          providerID: c.providerID.trim(),
          modelID: c.modelID.trim(),
          ...(typeof c.label === "string" && c.label.trim() ? { label: c.label.trim() } : {}),
        })
    }
  }
  return out
}

export const candidateKey = (c: { providerID: string; modelID: string }): string =>
  `${c.providerID}/${c.modelID}`

export const modelKeyOfRef = (ref: any): string => `${String(ref?.providerID ?? "")}/${String(ref?.id ?? "")}`

// "default" is the neutral state: no variant pinned.
const normVariant = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : "default"

export function refKey(ref: any): string {
  return JSON.stringify([
    String(ref?.providerID ?? ""),
    String(ref?.id ?? ""),
    normVariant(ref?.variant).toLowerCase(),
  ])
}

const labelOfRef = (ref: any): string => {
  const variant = normVariant(ref?.variant)
  const key = modelKeyOfRef(ref)
  return variant === "default" ? key : `${key}@${variant}`
}

// Normalizes a target ref for switchModel: "default"/absent variants drop out.
export function normalizeRef(ref: { providerID: string; modelID: string; variant?: string }): {
  providerID: string
  modelID: string
  variant?: string | undefined
} {
  const variant = ref.variant && ref.variant !== "default" ? ref.variant : undefined
  return variant ? { providerID: ref.providerID, modelID: ref.modelID, variant } : { providerID: ref.providerID, modelID: ref.modelID }
}

export interface PinRecord {
  to: any
  from: any
}

export function pinMatches(last: { to: any; from: any } | undefined | null, pin: PinRecord | undefined | null): boolean {
  if (!last || !pin || !pin.to || !pin.from) return false
  return refKey(last.to) === refKey(pin.to) && refKey(last.from) === refKey(pin.from)
}

// The manual-pick lattice for the model-routing path. A missing pin record
// means no own switch exists yet, so the newest switch (if any) is foreign.
//   "go"    - judge this prompt normally
//   "rearm" - the user came back to the base model; auto re-enables
//   "stand" - a manual pick is active; no jev call, no switching
export function routeDecision(
  last: { to: any; from: any } | undefined | null,
  pin: PinRecord | undefined | null,
  baseKey: string,
): "go" | "rearm" | "stand" {
  if (!last) return "go"
  if (pinMatches(last, pin)) return "go"
  return modelKeyOfRef(last.to) === baseKey ? "rearm" : "stand"
}

// ---------------------------------------------------------------------------
// Route question building
// ---------------------------------------------------------------------------

// Kept at 12 so every option stays inside one distribution window; each
// option is a full (model, level) rubric, so beyond that the probabilities
// thin out and the confidence signal degrades.
export const MAX_OPTIONS = 12

export interface ModelOption {
  /** Wire form in the question; the answer must name one of these. */
  key: string
  providerID: string
  modelID: string
  variant?: string | undefined
  criteria: string
  current?: boolean
}

const pairKey = (c: { providerID: string; modelID: string }, variant: string): string =>
  `${candidateKey(c)}#${variant}`

export interface PairOptionSource {
  candidate: Candidate
  /** Catalog-listed levels already filtered to known effort levels. */
  levels: string[]
}

// Builds (model, level) options: current model's listed levels first, then
// candidates in config order. A listed-variant-less candidate becomes a
// single "default" pair (a plain model switch). Candidates are dropped whole
// when the option count would exceed MAX_OPTIONS - never partially trimmed,
// so no option set biases a model toward only its cheap levels.
export function buildPairOptions(
  current: { providerID: string; modelID: string; variant: string },
  currentLevels: string[],
  candidateSources: PairOptionSource[],
  tier?: (providerID: string, modelID: string) => string,
): { options: ModelOption[]; included: Candidate[] } {
  const withTier = (providerID: string, modelID: string, text: string): string => {
    const hint = tier ? tier(providerID, modelID) : ""
    return hint ? `${text} (${hint})` : text
  }
  const options: ModelOption[] = []
  const currentKey = candidateKey(current)
  if (currentLevels.length > 0) {
    for (const level of currentLevels)
      options.push({
        key: pairKey(current, level),
        providerID: current.providerID,
        modelID: current.modelID,
        variant: level,
        criteria: withTier(current.providerID, current.modelID, `current model - ${levelCriteria(level)}`),
        current: true,
      })
  } else {
    options.push({
      key: pairKey(current, normVariant(current.variant)),
      providerID: current.providerID,
      modelID: current.modelID,
      variant: normVariant(current.variant),
      criteria: withTier(current.providerID, current.modelID, "current model - stay as configured"),
      current: true,
    })
  }
  const included: Candidate[] = []
  for (const source of candidateSources) {
    const levels = source.levels.length > 0 ? source.levels : ["default"]
    if (options.length + levels.length > MAX_OPTIONS) break
    for (const level of levels)
      options.push({
        key: pairKey(source.candidate, level),
        providerID: source.candidate.providerID,
        modelID: source.candidate.modelID,
        variant: level,
        criteria: withTier(
          source.candidate.providerID,
          source.candidate.modelID,
          `${source.candidate.label ?? candidateKey(source.candidate)} - ${
            level === "default"
              ? "model switch only (this model lists no reasoning variants)"
              : levelCriteria(level)
          }`,
        ),
      })
    included.push(source.candidate)
  }
  return { options, included }
}

// Model-only options (model routing without auto effort): the current model
// as the in-place choice, then candidates in config order.
export function buildModelOptions(
  current: { providerID: string; modelID: string },
  candidates: Candidate[],
  tier?: (providerID: string, modelID: string) => string,
): ModelOption[] {
  const withTier = (providerID: string, modelID: string, text: string): string => {
    const hint = tier ? tier(providerID, modelID) : ""
    return hint ? `${text} (${hint})` : text
  }
  const options: ModelOption[] = [
    {
      key: candidateKey(current),
      providerID: current.providerID,
      modelID: current.modelID,
      criteria: withTier(current.providerID, current.modelID, "current model - continue with it"),
      current: true,
    },
  ]
  for (const c of candidates) {
    if (options.length >= MAX_OPTIONS) break
    options.push({
      key: candidateKey(c),
      providerID: c.providerID,
      modelID: c.modelID,
      criteria: withTier(c.providerID, c.modelID, c.label ?? "alternate model from the routing config"),
    })
  }
  return options
}

// Maps the choice answer onto an option. Unknown or missing options are
// resolver errors - never decisions.
export function resolveRouteAnswer(
  answer: any,
  options: ModelOption[],
): { target: { providerID: string; modelID: string; variant?: string | undefined } } | { error: string } {
  const choice = typeof answer?.choice === "string" ? answer.choice.trim() : ""
  if (!choice) return { error: `uninterpretable answer (${JSON.stringify(answer?.choice ?? answer ?? null)})` }
  const hit = options.find((o) => o.key.toLowerCase() === choice.toLowerCase())
  if (!hit) return { error: `unknown option "${choice.slice(0, 80)}"` }
  const target = normalizeRef({ providerID: hit.providerID, modelID: hit.modelID, ...(hit.variant ? { variant: hit.variant } : {}) })
  return { target }
}

export const ROUTE_PAIR_INSTRUCTIONS =
  "Pick the (model, reasoning level) pair the assistant's turn should use: WHICH model runs the turn and HOW MUCH effort it gets. Prefer the CHEAPER model and the LOWER level that can still do the job - a cheap turn can be escalated later, but wasted effort cannot be taken back; escalate the model only when the message clearly demands a stronger one."

export const ROUTE_MODEL_INSTRUCTIONS =
  "Pick which model the assistant's turn should run on. The current model is one of the options - keep it unless another option clearly fits better. Prefer the cheaper model that can still do the job; escalate only when the message clearly needs more capability."

// ---------------------------------------------------------------------------
// Router: one jev round-trip per prompt -> a structured outcome the caller
// applies (switchModel, pin records, logs). Raising the outcome instead of
// performing I/O keeps the whole lattice testable without a plugin host.
// ---------------------------------------------------------------------------

export interface RouteConfig {
  /** Auto effort is on (legacy single-feature flow when model is off). */
  effort: boolean
  /** Auto model routing is on with at least one usable candidate. */
  model: boolean
  candidates: Candidate[]
  effortMinConfidence: number
  modelMinConfidence: number
}

export interface RouteInput {
  prompt: string
  current: { providerID: string; modelID: string; variant: string }
  levelsFor: (providerID: string, modelID: string) => Promise<string[]>
  lastSwitch?: { to: any; from: any } | null
  pin?: PinRecord | undefined | null
  /** The base model this session routes from (record or first observation). */
  base?: { providerID: string; modelID: string; variant?: string } | null
  /** Optional per-model price hint for the option criteria. */
  tier?: (providerID: string, modelID: string) => string
  /** Deterministic scrub applied to prompt + question state text. */
  scrub?: (text: string) => string
  judge: (questions: QuestionLike[], state: unknown, signal?: AbortSignal) => Promise<{ answers?: Record<string, any> }>
}

export interface RouteOutcome {
  mode: "off" | "stand" | "rearm" | "effort" | "model" | "pair"
  logs: string[]
  errors: string[]
  /** Present when the mode is "stand": the label the user picked (dedupe key). */
  pickedLabel?: string
  /** Set when this judged turn also re-armed a previously stood-down auto. */
  rearm?: boolean
  switchTo?: { providerID: string; modelID: string; variant?: string } | undefined
  recordPin?: { to: any; from: any }
}

const routeStateWrap = (lead: string, scrubbed: string): string => `${lead}\n\n<user>\n${scrubbed}\n</user>`

export async function routeTurn(config: RouteConfig, input: RouteInput): Promise<RouteOutcome> {
  const logs: string[] = []
  const errors: string[] = []
  const scrub = input.scrub ?? ((t: string) => t)
  const currentRef = {
    providerID: input.current.providerID,
    id: input.current.modelID,
    variant: normVariant(input.current.variant),
  }

  if (!config.effort && !config.model) return { mode: "off", logs, errors }

  // ---- legacy effort-only flow (unchanged semantics, variant picks only) ----
  if (!config.model) {
    const levels = await input.levelsFor(input.current.providerID, input.current.modelID)
    if (levels.length === 0) return { mode: "effort", logs, errors }
    const currentVariant = normVariant(input.current.variant)
    const current = currentVariant.toLowerCase()
    const last = input.lastSwitch
    if (last && !pinMatches(last, input.pin)) {
      if ((last.to?.variant ?? "default") === "default") {
        logs.push("[jev] effort: back to default - auto re-enabled")
        return { mode: "rearm", logs, errors, rearm: true }
      }
      const picked = String(last.to?.variant ?? "?")
      return {
        mode: "stand",
        pickedLabel: picked,
        logs: [`[jev] effort: manual pick ${picked} - auto stood down until Default`],
        errors,
      }
    }
    const question: QuestionLike = {
      id: "effort",
      type: "choice",
      instructions:
        "Which reasoning effort should this turn use? Pick the level matching the work the message asks for; between two levels prefer the LOWER one - a cheap turn can escalate later, but wasted thinking cannot be taken back.",
      criteria: Object.fromEntries(levels.map((level) => [level, levelCriteria(level)])),
    }
    const state = routeStateWrap(
      "A user message in an OpenCode coding session is quoted below. Decide how much reasoning effort the assistant's turn for it should use.",
      scrub(input.prompt.slice(0, 6000)),
    )
    let reply: { answers?: Record<string, any> }
    try {
      reply = await input.judge([question], state, AbortSignal.timeout(8_000))
    } catch (err: any) {
      errors.push(`[jev] effort: judge failed (${String(err?.message ?? err)}) - keeping ${currentRef.variant}`)
      return { mode: "effort", logs, errors }
    }
    const answer: any = reply?.answers?.effort
    const choice = typeof answer?.choice === "string" ? answer.choice.trim().toLowerCase() : ""
    if (!levels.includes(choice)) {
      logs.push(`[jev] effort: uninterpretable answer (${String(answer?.choice)}) - keeping ${current}`)
      return { mode: "effort", logs, errors }
    }
    if (choice === current) return { mode: "effort", logs, errors }
    if (typeof answer?.confidence === "number" && answer.confidence < config.effortMinConfidence) {
      logs.push(`[jev] effort: ${choice} uncertain (${fmtOf(answer.confidence)}) - keeping ${current}`)
      return { mode: "effort", logs, errors }
    }
    return {
      mode: "effort",
      logs: [
        `[jev] effort: ${current} → ${choice} (jev pick, confidence ${fmtOf(answer.confidence)})`,
      ],
      errors,
      switchTo: { providerID: currentRef.providerID, modelID: currentRef.id, variant: choice },
      recordPin: {
        to: { providerID: currentRef.providerID, id: currentRef.id, variant: choice },
        from: { providerID: currentRef.providerID, id: currentRef.id, variant: currentVariant },
      },
    }
  }

  // ---- model routing path (base record required) ----
  const last = input.lastSwitch
  let rearmed = false
  // base is Candidate-shaped ({ providerID, modelID }); currentRef is
  // ref-shaped ({ providerID, id }) exactly like the transcript's
  // model-switched messages, so pin comparisons need no conversion.
  const base =
    input.base && input.base.providerID && input.base.modelID
      ? input.base
      : { providerID: currentRef.providerID, modelID: currentRef.id, variant: currentRef.variant }
  const baseKey = candidateKey(base)
  const currentKey = modelKeyOfRef(currentRef)

  const failToBase = (message: string): RouteOutcome => {
    const ours = last ? pinMatches(last, input.pin) : false
    if (!ours) return { mode: "model", logs, errors: [...errors, message], ...(rearmed ? { rearm: true } : {}) }
    if (currentKey === baseKey)
      return { mode: "model", logs, errors: [...errors, message], ...(rearmed ? { rearm: true } : {}) }
    return {
      mode: "model",
      logs,
      errors: [...errors, `${message} - reverting to ${baseKey}`],
      ...(rearmed ? { rearm: true } : {}),
      switchTo: normalizeRef({ providerID: base.providerID, modelID: base.modelID, ...(base.variant ? { variant: base.variant } : {}) }),
      recordPin: {
        to: toRef({ providerID: base.providerID, modelID: base.modelID, ...(base.variant ? { variant: base.variant } : {}) }),
        from: currentRef,
      },
    }
  }

  if (last && !pinMatches(last, input.pin)) {
    // Foreign (manual) pick: stand down until the user returns to base -
    // which re-arms auto and continues judging this prompt normally. The
    // adapter prints the re-arm notice once per stood-down pick.
    if (modelKeyOfRef(last.to) === baseKey) {
      logs.push(`[jev] route: back at ${baseKey} - auto re-enabled`)
      rearmed = true
    } else {
      const picked = labelOfRef(last.to)
      return {
        mode: "stand",
        pickedLabel: picked,
        logs: [`[jev] route: manual pick ${picked} - auto stood down until back at ${baseKey}`],
        errors,
      }
    }
  }

  const pairMode = config.effort && config.candidates.length > 0
  const finalize = (extra: Partial<RouteOutcome>): RouteOutcome => ({
    mode: pairMode ? "pair" : "model",
    logs,
    errors,
    ...(rearmed ? { rearm: true } : {}),
    ...extra,
  })

  let options: ModelOption[]
  let question: QuestionLike
  let lead: string
  if (pairMode) {
    const currentLevels = (await input.levelsFor(input.current.providerID, input.current.modelID)).filter((l) =>
      EFFORT_ORDER.includes(l),
    )
    const sources: PairOptionSource[] = []
    for (const c of config.candidates) sources.push({ candidate: c, levels: await input.levelsFor(c.providerID, c.modelID) })
    const built = buildPairOptions(
      { providerID: currentRef.providerID, modelID: currentRef.id, variant: currentRef.variant },
      currentLevels,
      sources,
      input.tier,
    )
    options = built.options
    if (options.length === 0) return failToBase("[jev] route: no options could be built")
    lead =
      "A user message in an OpenCode coding session is quoted below. Decide which model should run the assistant's turn and how much reasoning effort it should use; the available model+level pairs are listed in the question."
    question = { id: "route", type: "choice", instructions: ROUTE_PAIR_INSTRUCTIONS, criteria: Object.fromEntries(options.map((o) => [o.key, o.criteria])) }
  } else {
    options = buildModelOptions(
      { providerID: currentRef.providerID, modelID: currentRef.id },
      config.candidates,
      input.tier,
    )
    lead =
      "A user message in an OpenCode coding session is quoted below. Decide which model should run the assistant's turn for it; the available models are listed in the question."
    question = { id: "route", type: "choice", instructions: ROUTE_MODEL_INSTRUCTIONS, criteria: Object.fromEntries(options.map((o) => [o.key, o.criteria])) }
  }

  let reply: { answers?: Record<string, any> }
  try {
    reply = await input.judge([question], routeStateWrap(lead, scrub(input.prompt.slice(0, 6000))), AbortSignal.timeout(8_000))
  } catch (err: any) {
    return failToBase(`[jev] route: judge failed (${String(err?.message ?? err)})`)
  }
  if (!reply?.answers || typeof reply.answers !== "object") return failToBase("[jev] route: malformed response (no answers)")

  const resolved = resolveRouteAnswer(reply.answers.route, options)
  if ("error" in resolved) return failToBase(`[jev] route: ${resolved.error}`)

  const answer: any = reply.answers.route
  if (typeof answer.confidence === "number" && answer.confidence < config.modelMinConfidence) {
    logs.push(`[jev] route: ${resolved.target ? labelOfRef(toRef(resolved.target)) : "?"} uncertain (${fmtOf(answer.confidence)}) - keeping ${labelOfRef(currentRef)}`)
    return finalize({})
  }

  const targetKey = modelKeyOfRef(toRef(resolved.target))
  const targetVariant = normVariant(resolved.target.variant)
  if (targetKey === currentKey && targetVariant === currentRef.variant) {
    return finalize({}) // kept as-is, nothing to record
  }
  logs.push(`[jev] route: ${labelOfRef(currentRef)} → ${labelOfRef(toRef(resolved.target))} (jev pick, confidence ${fmtOf(answer.confidence)})`)
  return finalize({
    switchTo: resolved.target,
    recordPin: { to: toRef(resolved.target), from: currentRef },
  })
}

// toRef: switches/pins store refs the way OpenCode emits them (id not modelID).
export const toRef = (t: { providerID: string; modelID: string; variant?: string | undefined }): any => ({
  providerID: t.providerID,
  id: t.modelID,
  ...(t.variant && t.variant !== "default" ? { variant: t.variant } : {}),
})

const fmtOf = (v: unknown): string => (typeof v === "number" ? v.toFixed(2) : "?")

// ---------------------------------------------------------------------------
// Done-check: transcript tail building, change detection and thresholds
// ---------------------------------------------------------------------------

// Plugin-posted notices ([jev-...] synthetic rows) are excluded from both the
// judged transcript and the change hash, so one own notice can never re-trigger.
export function isOwnNoticeRow(text: string): boolean {
  return typeof text === "string" && text.startsWith("[jev-")
}

export function doneTranscript(
  messages: any[],
  options?: { maxMessages?: number; perMessageChars?: number; totalChars?: number },
): { text: string; hash: string } {
  const maxMessages = options?.maxMessages ?? 24
  const perMessageChars = options?.perMessageChars ?? 500
  const totalChars = options?.totalChars ?? 12000
  const text = messages
    .slice(-maxMessages)
    .map((m: any) => {
      const text = typeof m?.info?.text === "string"
        ? m.info.text
        : typeof m?.text === "string"
          ? m.text
          : JSON.stringify(m).slice(0, 300)
      return text.slice(0, perMessageChars)
    })
    .filter((line: string) => !isOwnNoticeRow(line))
    .join("\n")
    .slice(-totalChars)
  return { text, hash: createHash("sha256").update(text).digest("hex") }
}

export const doneVerdict = (done: number | undefined): string =>
  typeof done === "number"
    ? done >= 0.85
      ? "complete"
      : done <= 0.5
        ? "likely INCOMPLETE (tie or lower) - list what remains"
        : "uncertain - surface what is missing before declaring done"
    : "unavailable (malformed answer - fail closed)"

export const clampThreshold = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

// The auto done-check posts a notice only when completion looks UNLIKELY.
// The uncertain band (between NotifyBelow and 0.85) stays silent on purpose.
export function shouldNotifyIncomplete(done: number | undefined, notifyBelow: number): boolean {
  return typeof done === "number" && done <= notifyBelow
}

export const NOTIFY_BELOW_DEFAULT = 0.45

// ---------------------------------------------------------------------------
// Screen: tool-name gate and the redact scope rule
// ---------------------------------------------------------------------------

export type ScreenTools = string[] | "all"

export function parseScreenTools(raw: unknown): ScreenTools {
  if (raw === "all") return "all"
  if (Array.isArray(raw) && raw.length > 0 && raw.every((t) => typeof t === "string" && t.trim() !== "")) {
    return Array.from(new Set((raw as string[]).map((t) => t.trim())))
  }
  return ["webfetch"]
}

// Tools this plugin itself registers - their outputs are verdicts that are
// already judged (or are jev_find's own screened states); screening them
// again adds cost for no signal.
export const SELF_SCREENED_TOOLS: ReadonlySet<string> = new Set(["jev/decide", "jev/judge_many", "jev_find"])

export function screenApplies(tool: string, tools: ScreenTools, self: ReadonlySet<string> = SELF_SCREENED_TOOLS): boolean {
  if (self.has(tool)) return false
  return tools === "all" || tools.includes(tool)
}

// Fail-closed redaction deliberately stays scoped to fetched web content:
// redacting arbitrary bash output destroys its usefulness; other tool
// results are annotated only.
export function screenRedacts(tool: string): boolean {
  return tool === "webfetch"
}

// ---------------------------------------------------------------------------
// Find cascade primitives (lexical ranking, windowing, report formatting)
// ---------------------------------------------------------------------------

export const FIND_STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","is","are","was","were","be","been","how","do","does","did","what","which","who","where","when","why","that","this","these","there","it","its","as","at","by","from","into","about","can","could","should","would","will","need","needs","find","finds","show","shows","me","my","our","code","file","files","any","all","some","use","uses","using",
])

export function keywordsOf(query: string): string[] {
  const tokens = String(query ?? "")
    .toLowerCase()
    .match(/[a-z0-9_]{2,}/g) ?? []
  const out: string[] = []
  for (const t of tokens) {
    if (FIND_STOPWORDS.has(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  return out.slice(0, 12)
}

// Plain relational scorer over the file path: basename hits weigh 3x
// directory hits. This is step 1 of the cascade - jev never sees it, it only
// narrows which paths get judged.
export function scorePath(relPath: string, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const p = relPath.toLowerCase()
  const base = p.slice(p.lastIndexOf("/") + 1)
  const dir = p.slice(0, Math.max(0, p.lastIndexOf("/")))
  let score = 0
  for (const kw of keywords) {
    if (base.includes(kw)) score += 3
    else if (dir.includes(kw)) score += 2
  }
  return score
}

// Never-selected paths: agents' own state, build outputs, and files whose
// content is likely a credential (the judged states are scrubbed, but excerpt
// quotes ride back into the agent's context - keep them out entirely).
export const SKIP_PATH: Array<RegExp> = [
  /(^|\/)\.git($|\/)/,
  /(^|\/)node_modules\//,
  /(^|\/)\.opencode($|\/)/,
  /(^|\/)dist($|\/)/,
  /(^|\/)build($|\/)/,
  /(^|\/)out($|\/)/,
  /(^|\/)\.cache\//,
  /(^|\/)target\//,
  /package-lock\.json$/,
  /(^|\/)(bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json)$/,
  /(^|\/)[^/]*\.min\.(js|css)$/,
  /(^|\/)vendor\//,
]

export const SENSITIVE_PATH: Array<RegExp> = [
  /(^|\/)\.env/,
  /(^|\/)(id_rsa|id_dsa|id_ed25519|id_ecdsa)/,
  /(^|\/)secrets?\b/i,
  /(^|\/)credentials?\b/i,
  /(^|\/)[^/]*\.pem$/,
  /(^|\/)[^/]*\.key$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)auth\.json$/,
]

export const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","webp","svgz","ico","pdf","zip","tar","gz","tgz","bz2","xz","7z","rar","jar","war","class","so","dylib","dll","exe","bin","o","a","lib","wasm","mp3","mp4","mov","avi","mkv","wav","flac","ogg","ttf","otf","woff","woff2","eot","sqlite","db","pdb","pyc","pyo","beam",
])

export function pathEligible(relPath: string, size: number, maxFileBytes = 160_000): boolean {
  if (size > maxFileBytes) return false
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase()
  if (relPath.includes(".") && BINARY_EXTS.has(ext)) return false
  if (SKIP_PATH.some((rx) => rx.test(relPath))) return false
  if (SENSITIVE_PATH.some((rx) => rx.test(relPath))) return false
  return true
}

export interface Window {
  /** Character offset of the window start in the ORIGINAL text. */
  offset: number
  /** Line number (1-based) of the window start in the original text. */
  line: number
  text: string
}

// Line-boundary splitting into byte-bounded verbatim windows: judging sees
// complete lines only, so a quote produced later is always from a real
// contiguous region of the file.
export function splitWindows(text: string, windowBytes: number, maxWindows: number): Window[] {
  const starts = lineStartsOf(text)
  const windows: Window[] = []
  let offset = 0
  while (offset < text.length && windows.length < maxWindows) {
    const want = Math.min(windowBytes, text.length - offset)
    let end = offset + want
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end)
      if (nl > offset) end = nl + 1
      else end = text.indexOf("\n", end) + 1 || text.length
    }
    windows.push({ offset, line: lineNumberFor(starts, offset), text: text.slice(offset, end) })
    offset = end
  }
  return windows
}

/** Ascending character offsets where lines start (1 line of line 1 at 0). */
export function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** 1-based line number for a character offset via lineStartsOf output. */
export function lineNumberFor(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** End line (1-based, inclusive) for a window that ends before `endOffset`. */
export function lineAtEnd(lineStarts: number[], endOffset: number): number {
  const line = lineNumberFor(lineStarts, Math.max(0, endOffset - 1))
  return line
}

// Bounded parallel map with per-item error tolerance: one failed judgment
// never sinks the whole phase.
export type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }

export async function bounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const results: Array<Settled<R>> = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
  return results
}

export interface FindHit {
  path: string
  heat: number
  lines: [number, number]
  excerpt: string
}

export function fmtFindReport(input: {
  query: string
  scanned: number
  nameJudged: number
  nameErrors: number
  windowsJudged: number
  windowErrors: number
  hits: FindHit[]
  fallback?: boolean
}): string {
  const head =
    `jev_find(${input.query.slice(0, 120)}) → ${input.scanned} files scanned, ${input.nameJudged} paths judged, ${input.windowsJudged} excerpts judged` +
    (input.fallback ? " (jev unavailable - lexical order only)" : "")
      + `.${input.nameErrors || input.windowErrors ? ` (${input.nameErrors} path and ${input.windowErrors} excerpt judgments errored)` : ""}`
  if (input.hits.length === 0) return `${head}\nNo relevant hits.`
  const body = input.hits
    .map((h, i) => `${i + 1}. ${h.path} - heat ${h.heat.toFixed(2)} (lines ${h.lines[0]}-${h.lines[1]})\n   ${h.excerpt}`)
    .join("\n")
  return `${head}\nRanked hits are routing signals only - read the files before relying on them:\n${body}`
}
