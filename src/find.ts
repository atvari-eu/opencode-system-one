// jev_find - a jev-driven semantic code search, ported from oh-my-pi's native
// `find` cascade onto this plugin's primitives. Simplified for the plugin:
// no fs-scan cache (the host has none), no sketch triage phase (windows are
// judged directly from complete text), and a plain relational prefilter
// instead of an IDF index.
//
// Cascade (three jev waves after a free lexical pass):
//   1. lexical scan ranks every eligible path by the query's keywords
//   2. filename judgments prune the top candidates down to the files that
//      get read (one noul per path, one state per path, bounded parallel)
//   3. passage judgments score byte-bounded verbatim windows of the read
//      files; heat always comes from a complete window of the file
//
// Judgments are routing signals only: hits quote complete windows, and the
// tool result tells the model to read files before relying on them. Secret
// scrubbing applies to every judged state AND every quoted excerpt, and
// secret-looking paths are never selected at all.

import * as path from "node:path"
import * as fsp from "node:fs/promises"
import {
  type QuestionLike,
  type FindHit,
  bounded,
  fmtFindReport,
  keywordsOf,
  lineAtEnd,
  lineStartsOf,
  pathEligible,
  scorePath,
  splitWindows,
} from "./logic"

export interface FindJudge {
  (
    questions: QuestionLike[],
    state: unknown,
    signal?: AbortSignal,
  ): Promise<{ answers?: Record<string, any> }>
}

export interface FindDeps {
  /** Workspace root all paths are relative to ("" means unknown). */
  root: () => string
  judge: FindJudge
  /** Deterministic secret scrub for judged states and quoted excerpts. */
  scrub: (text: string) => string
  log?: (line: string) => void
}

export interface FindRunOptions {
  signal?: AbortSignal
  maxFiles?: number
  parallel?: number
}

// Cascade budgets - deliberately small defaults: a query costs tens of jev
// calls, and every request is one state + one question. maxFiles caps the
// walk; keepFiles caps how many files get read and windowed.
export const FIND_LIMITS = {
  maxFiles: 2000,
  candidateMax: 96,
  keepFiles: 12,
  windowsPerFile: 12,
  windowBytes: 8192,
  fileBytes: 160_000,
  excerptChars: 400,
  excerptLines: 3,
  topHits: 5,
  fallbackHits: 10,
}

const NAME_QUESTION: QuestionLike = {
  id: "relevant",
  type: "noul",
  instructions:
    "Given this user query, how plausible is this file path (name, directories, extension) as an entry point for finding information that answers it? Judge ONLY the path text you can see - never higher than 0.35 for a path that merely shares a keyword; near 1.0 only for a name that clearly identifies the concept in the query.",
}

const WINDOW_QUESTION: QuestionLike = {
  id: "relevant",
  type: "noul",
  instructions:
    "Given this user query, does this complete excerpt from a source file contain information needed to answer it? Judge only the visible content: near 1.0 when the substance of the answer is present, round 0.5 for indirect hints, low for boilerplate or unrelated code.",
}

const PER_CALL_TIMEOUT_MS = 10_000

interface FileEntry {
  rel: string
  size: number
}

async function walk(root: string, maxFiles: number): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  const walkDir = async (dir: string, rel: string): Promise<void> => {
    if (out.length >= maxFiles) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= maxFiles) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (pathEligible(`${childRel}/`, 0)) await walkDir(path.join(dir, entry.name), childRel)
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(path.join(dir, entry.name))
          if (pathEligible(childRel, st.size)) out.push({ rel: childRel, size: st.size })
        } catch {}
      }
    }
  }
  await walkDir(root, "")
  return out
}

const noulOf = (reply: { answers?: Record<string, any> } | undefined): number | undefined => {
  const v = (reply?.answers as any)?.relevant
  return typeof v === "number" ? v : (v as any)?.type === "noul" ? (v as any).noul : typeof v?.noul === "number" ? v.noul : undefined
}

const oneCall = (deps: FindDeps, question: QuestionLike, state: string, signal?: AbortSignal): Promise<number> =>
  deps.judge([question], state, signal).then((reply) => {
    const v = typeof noulOf(reply) === "number" ? (noulOf(reply) as number) : NaN
    if (!Number.isFinite(v)) throw new Error("unusable answer")
    return v
  })

/** Runs the full cascade. Returns the tool result text (never throws). */
export async function runFind(deps: FindDeps, rawQuery: string, options: FindRunOptions = {}): Promise<string> {
  const query = String(rawQuery ?? "").trim()
  const root = deps.root()
  const limits = FIND_LIMITS
  const parallel = Math.max(1, Math.min(16, options.parallel ?? 16))
  let signal = options.signal
  const callSignal = (): AbortSignal => {
    const per = AbortSignal.timeout(PER_CALL_TIMEOUT_MS)
    try {
      return signal ? AbortSignal.any([signal, per]) : per
    } catch {
      return per
    }
  }

  if (!query) return "jev_find: empty query - pass a short natural-language question."
  if (!root) return "jev_find: no workspace directory is known to the plugin; open a project first."

  const files = await walk(root, options.maxFiles ?? limits.maxFiles)
  if (files.length === 0) return `jev_find(${query.slice(0, 120)}) → 0 eligible files under ${root}.`

  const keywords = keywordsOf(query)
  const scored = files
    .map((f) => ({ ...f, score: scorePath(f.rel, keywords) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.rel < b.rel ? -1 : 1))
    .slice(0, limits.candidateMax)

  const q = deps.scrub(query)
  let nameJudged = 0
  let nameErrors = 0
  let windowsJudged = 0
  let windowErrors = 0
  let kept: FileEntry[] = []
  let hitList: FindHit[] = []

  try {
    // -- phase 2: filename judgments (one path per state) --
    const nameSettled = await bounded(scored, parallel, async (candidate) => {
      const state = `User query: ${q}\n\nFile path: ${candidate.rel} (${Math.max(1, Math.ceil(candidate.size / 1024))} kB)`
      return oneCall(deps, NAME_QUESTION, state, callSignal())
    })
    const named = scored
      .map((candidate, i) => {
        const r = nameSettled[i]
        if (r.status === "fulfilled") {
          nameJudged++
          return { ...candidate, judged: r.value }
        }
        nameErrors++
        return { ...candidate, judged: NaN }
      })
      .sort((a, b) => {
        const pa = Number.isFinite(a.judged) ? a.judged : -1
        const pb = Number.isFinite(b.judged) ? b.judged : -1
        if (pa !== pb) return pb - pa
        return a.score !== b.score ? b.score - a.score : a.rel < b.rel ? -1 : 1
      })

    // All judgments failing is the fallback trigger; a few errors just shrink
    // the judged pool.
    if (nameJudged > 0) {
      kept = named
        .filter((n) => Number.isFinite(n.judged))
        .slice(0, limits.keepFiles)
        .map((n) => ({ rel: n.rel, size: n.size }))
    } else {
      kept = named.slice(0, Math.min(limits.keepFiles, named.length)).map((n) => ({ rel: n.rel, size: n.size }))
    }

    // -- phase 3: read + window the kept files --
    const reads = await Promise.all(
      kept.map(async (entry) => {
        try {
          const raw = await fsp.readFile(path.join(root, entry.rel), "utf8")
          const text = raw.length > limits.fileBytes ? raw.slice(0, limits.fileBytes) : raw
          return { ...entry, text, truncated: raw.length > text.length }
        } catch {
          return { ...entry, text: "", truncated: false }
        }
      }),
    )
    const readable = reads.filter((r) => r.text.length > 0)
    const starts = new Map(readable.map((r) => [r.rel, lineStartsOf(r.text)]))
    const windows = readable.flatMap((r) =>
      splitWindows(r.text, limits.windowBytes, limits.windowsPerFile).map((w) => ({ file: r.rel, ...w })),
    )

    // -- phase 4: passage judgments (one window per state) --
    const windowSettled = await bounded(windows, parallel, async (w) => {
      const end = w.offset + w.text.length
      const endLine = lineAtEnd(starts.get(w.file)!, end)
      const state =
        `User query: ${q}\n\n` +
        `Excerpt from ${w.file} (lines ${w.line}-${endLine}):\n${deps.scrub(w.text)}`
      return oneCall(deps, WINDOW_QUESTION, state, callSignal())
    })

    const bestPerFile = new Map<string, { heat: number; window?: (typeof windows)[number] }>()
    for (let i = 0; i < windows.length; i++) {
      const r = windowSettled[i]
      if (r.status === "fulfilled") {
        windowsJudged++
        const heat = r.value
        const prev = bestPerFile.get(windows[i].file)
        if (!prev || heat > prev.heat) bestPerFile.set(windows[i].file, { heat, window: windows[i] })
      } else {
        windowErrors++
      }
    }

    hitList = [...bestPerFile.entries()]
      .filter(([, v]) => v.window && v.heat >= 0.5)
      .sort((a, b) => b[1].heat - a[1].heat)
      .slice(0, limits.topHits)
      .map(([rel, v]) => {
        const lineStarts = starts.get(rel)!
        const w = v.window!
        const endLine = lineAtEnd(lineStarts, w.offset + w.text.length)
        const excerpt = excerptOf(deps.scrub(w.text))
        return { path: rel, heat: v.heat, lines: [w.line, endLine] as [number, number], excerpt }
      })
  } catch (err: any) {
    if (signal?.aborted) return `jev_find aborted.`
    deps.log?.(`jev_find cascade error: ${String(err?.message ?? err)}`)
  }

  if (hitList.length === 0 && windowsJudged === 0 && nameJudged === 0) {
    // Fallback: pure lexical ranking, clearly labeled as signals-less.
    const fallbackHits: FindHit[] = scored.slice(0, limits.fallbackHits).map((f) => ({
      path: f.rel,
      heat: 0,
      lines: [1, 1],
      excerpt: "(no jev judgment available - lexical rank only)",
    }))
    return fmtFindReport({
      query,
      scanned: files.length,
      nameJudged,
      nameErrors,
      windowsJudged,
      windowErrors,
      hits: fallbackHits,
      fallback: true,
    })
  }

  return fmtFindReport({
    query,
    scanned: files.length,
    nameJudged,
    nameErrors,
    windowsJudged,
    windowErrors,
    hits: hitList,
  })
}

function excerptOf(text: string): string {
  const lines = text.split("\n").slice(0, FIND_LIMITS.excerptLines)
  let out = lines.join(" ⏎ ")
  if (out.length > FIND_LIMITS.excerptChars) out = `${out.slice(0, FIND_LIMITS.excerptChars)}…`
  return out
}
