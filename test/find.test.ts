// Find cascade tests: pure primitives plus one integration run over a temp
// workspace with a scripted judge (no live jev, no plugin host).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  bounded,
  fmtFindReport,
  keywordsOf,
  lineStartsOf,
  lineNumberFor,
  pathEligible,
  scorePath,
  splitWindows,
  lineAtEnd,
} from "../src/logic"
import { runFind, type FindDeps } from "../src/find"

describe("lexical prefilter", () => {
  test("keywords drop stopwords and caps the count", () => {
    const kws = keywordsOf("How does the ORCHESTRATION pipeline get scheduled?")
    expect(kws).toEqual(["orchestration", "pipeline", "get", "scheduled"])
    expect(keywordsOf("a b c d e f g h i j k l m n o p q").length).toBeLessThanOrEqual(12)
  })

  test("basename beats directory beats path-only; nothing matches = 0", () => {
    const kws = ["pipeline"]
    expect(scorePath("src/pipeline.rs", kws)).toBe(3)
    expect(scorePath("src/scheduler/pipeline.rs", kws)).toBe(3)
    expect(scorePath("src/pipeline.md", kws)).toBe(3)
    expect(scorePath("docs/pipeline-design.md", kws)).toBe(3)
    expect(scorePath("src/pipeline/run.ts", kws)).toBe(2)
    expect(scorePath("lib/pipeline/helpers.ts", kws)).toBe(2)
    expect(scorePath("src/main.ts", kws)).toBe(0)
  })
})

describe("path eligibility", () => {
  test("skips agent state, build output and lockfiles", () => {
    expect(pathEligible("src/main.ts", 10)).toBe(true)
    expect(pathEligible(".git/config", 10)).toBe(false)
    expect(pathEligible("node_modules/pkg/index.js", 10)).toBe(false)
    expect(pathEligible("dist/bundle.js", 10)).toBe(false)
    expect(pathEligible("bun.lock", 10)).toBe(false)
    expect(pathEligible("app.min.js", 10)).toBe(false)
    expect(pathEligible("deep/nested/vendor/lib.go", 10)).toBe(false)
  })

  test("never selects secret-looking paths", () => {
    expect(pathEligible(".env", 10)).toBe(false)
    expect(pathEligible(".env.local", 10)).toBe(false)
    expect(pathEligible("ssh/id_ed25519", 10)).toBe(false)
    expect(pathEligible("tls/server.pem", 10)).toBe(false)
    expect(pathEligible("secrets/prod.yaml", 10)).toBe(false)
    expect(pathEligible("config/credentials.json", 10)).toBe(false)
  })

  test("skips binaries and oversized files", () => {
    expect(pathEligible("logo.png", 10)).toBe(false)
    expect(pathEligible("data.sqlite", 10)).toBe(false)
    expect(pathEligible("assets/font.woff2", 10)).toBe(false)
    expect(pathEligible("big.ts", 161_000)).toBe(false)
    expect(pathEligible("big.ts", 160_000)).toBe(true)
  })
})

describe("windowing", () => {
  test("windows stay under the byte budget and carry line numbers", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(80)}`)
    const text = lines.join("\n") + "\n"
    const windows = splitWindows(text, 8192, 12)
    expect(windows.length).toBeGreaterThan(3)
    const starts = lineStartsOf(text)
    for (const w of windows) {
      expect(w.text.length).toBeLessThanOrEqual(8192)
      // window starts exactly on the claimed line
      expect(lineNumberFor(starts, w.offset)).toBe(w.line)
    }
    // contiguity: windows tile the text with no gaps
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].offset).toBe(windows[i - 1].offset + windows[i - 1].text.length)
    }
  })

  test("respects the window cap, first windows win", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `row-${i}`).join("\n")
    const windows = splitWindows(text, 512, 4)
    expect(windows.length).toBe(4)
    expect(windows[0].line).toBe(1)
    const ends = windows.map((w) => lineAtEnd(lineStartsOf(text), w.offset + w.text.length))
    expect(ends[0]).toBeGreaterThan(1)
  })

  test("single short text yields one window", () => {
    const windows = splitWindows("hello world", 8192, 12)
    expect(windows).toEqual([{ offset: 0, line: 1, text: "hello world" }])
  })
})

describe("bounded concurrency", () => {
  test("caps parallel workers and tolerates per-item errors", async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    const settled = await bounded(items, 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      if (n === 4) throw new Error("boom")
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(9)
    expect(settled[4]).toMatchObject({ status: "rejected" })
    expect((settled[0] as any).value).toBe(0)
    expect((settled[9] as any).value).toBe(18)
  })
})

describe("report formatting", () => {
  test("hit list shows heat, lines and excerpts with the signal caveat", () => {
    const report = fmtFindReport({
      query: "orchestration",
      scanned: 100,
      nameJudged: 96,
      nameErrors: 1,
      windowsJudged: 40,
      windowErrors: 2,
      hits: [{ path: "src/pipeline.ts", heat: 0.92, lines: [12, 24], excerpt: "const scheduler = start()" }],
    })
    expect(report).toContain("jev_find(orchestration)")
    expect(report).toContain("src/pipeline.ts")
    expect(report).toContain("heat 0.92")
    expect(report).toContain("lines 12-24")
    expect(report).toContain("routing signals only")
    expect(report).toContain("1 path and 2 excerpt judgments errored")
  })

  test("empty hit list reports no hits", () => {
    const report = fmtFindReport({
      query: "q",
      scanned: 10,
      nameJudged: 10,
      nameErrors: 0,
      windowsJudged: 0,
      windowErrors: 0,
      hits: [],
    })
    expect(report).toContain("No relevant hits.")
  })
})

// ---------------------------------------------------------------------------
// Integration: full cascade over a temp workspace with a scripted judge.
// ---------------------------------------------------------------------------

let workspace = ""

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join("/tmp/opencode", "jev-find-test-"))
  await fs.mkdir(path.join(workspace, "src"), { recursive: true })
  await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
  await fs.writeFile(
    path.join(workspace, "src", "jev-scheduler.ts"),
    [
      "// scheduler entrypoint",
      "",
      "import { pipeline } from './pipeline'",
      "",
      "export function scheduleAll() {",
      "  // orchestration pipeline scheduled every minute",
      "  pipeline.every('1m', run)",
      "}",
      "",
      "function run() { /* no-op */ }",
    ].join("\n"),
  )
  await fs.writeFile(
    path.join(workspace, "src", "unrelated.ts"),
    "export const greeting = 'hello world'\n",
  )
  await fs.writeFile(
    path.join(workspace, "docs", "pipeline-design.md"),
    [
      "# pipeline design notes",
      "",
      "The orchestration pipeline is scheduled in src/jev-scheduler.ts.",
      "Nothing else matters here.",
    ].join("\n"),
  )
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=never-selected\n")
  await fs.writeFile(path.join(workspace, "logo.png"), "not a real png")
})

afterAll(async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true })
})

const makeDeps = (): FindDeps => ({
  root: () => workspace,
  scrub: (t: string) => t,
  judge: async (_questions, state) => {
    const text = String(state)
    if (text.includes("File path:")) {
      // Name judgment phase.
      const rel = text.split("File path: ")[1]?.split("\n")[0]?.trim() ?? ""
      const good = rel.includes("scheduler") || rel.includes("pipeline")
      return { answers: { relevant: good ? 0.9 : 0.1 } }
    }
    // Window judgment phase: judge the excerpt part only, never the echoed
    // query (whose text contains the phrase and would match everything).
    const excerptAt = text.indexOf("Excerpt from")
    const content = excerptAt === -1 ? "" : text.slice(excerptAt)
    const good = content.includes("orchestration pipeline")
    return { answers: { relevant: good ? 0.94 : 0.2 } }
  },
})

describe("runFind integration", () => {
  test("ranks passage hits with line numbers and never leaks secrets", async () => {
    const report = await runFind(makeDeps(), "how is the orchestration pipeline scheduled?")
    // Both relevant files score 0.94; docs ranks first (name-score tiebreak).
    expect(report).toContain("docs/pipeline-design.md - heat 0.94 (lines 1-4)")
    expect(report).toMatch(/src\/jev-scheduler\.ts - heat 0\.94 \(lines 1-10\)/)
    expect(report).toContain("The orchestration pipeline is scheduled in src/jev-scheduler.ts.")
    expect(report).not.toContain("src/unrelated.ts")
    expect(report).not.toContain(".env")
    expect(report).not.toContain("SECRET=never-selected")
    expect(report).toContain("routing signals only")
  })

  test("empty query is refused", async () => {
    const report = await runFind(makeDeps(), "   ")
    expect(report).toContain("empty query")
  })

  test("total judge failure falls back to lexical order, clearly labeled", async () => {
    const deps = makeDeps()
    deps.judge = async () => {
      throw new Error("endpoint down")
    }
    const report = await runFind(deps, "pipeline scheduling")
    expect(report).toContain("jev unavailable")
    expect(report).toContain("src/jev-scheduler.ts")
  })

  test("unknown workspace root is reported", async () => {
    const deps = makeDeps()
    deps.root = () => ""
    const report = await runFind(deps, "anything")
    expect(report).toContain("no workspace directory")
  })
})
