// Screen gate tests: tool-name filtering, self-skip, verdict bands, and the
// canonical runScreen flow shared by the tool and the automatic hook.

import { describe, expect, test } from "bun:test"
import { runScreen } from "../src/screen"
import {
  parseScreenTools,
  screenApplies,
  screenRedacts,
  screenVerdict,
  parseScreenAnnotation,
  parseScreenMode,
  SELF_SCREENED_TOOLS,
  parseScreenNotice,
} from "../src/logic"

describe("parseScreenTools", () => {
  test("default is webfetch only", () => {
    expect(parseScreenTools(undefined)).toEqual(["webfetch"])
    expect(parseScreenTools([])).toEqual(["webfetch"])
    expect(parseScreenTools(["", 42 as any])).toEqual(["webfetch"])
  })

  test("explicit lists are trimmed and deduplicated", () => {
    expect(parseScreenTools(["webfetch", " bash ", "webfetch"])).toEqual(["webfetch", "bash"])
  })

  test('"all" enables every tool', () => {
    expect(parseScreenTools("all")).toBe("all")
  })
})

describe("screenApplies", () => {
  test("default list screens only webfetch", () => {
    expect(screenApplies("webfetch", ["webfetch"])).toBe(true)
    expect(screenApplies("bash", ["webfetch"])).toBe(false)
  })

  test('"all" screens everything except self tools', () => {
    expect(screenApplies("bash", "all")).toBe(true)
    expect(screenApplies("edit", "all")).toBe(true)
    for (const self of Object.keys(SELF_SCREENED_TOOLS)) {
      expect(screenApplies(self, "all")).toBe(false)
    }
  })

  test("self tools are skipped even when listed explicitly", () => {
    expect(screenApplies("jev_find", ["jev_find", "webfetch"])).toBe(false)
  })
})

describe("screenRedacts", () => {
  test("fail-closed redaction stays scoped to fetched web content", () => {
    expect(screenRedacts("webfetch")).toBe(true)
    expect(screenRedacts("bash")).toBe(false)
    expect(screenRedacts("edit")).toBe(false)
  })
})

describe("parseScreenAnnotation", () => {
  test("notice is the default; only 'inline' opts back in", () => {
    expect(parseScreenAnnotation(undefined)).toBe("notice")
    expect(parseScreenAnnotation(false)).toBe("notice")
    expect(parseScreenAnnotation("notice")).toBe("notice")
    expect(parseScreenAnnotation("INLINE")).toBe("notice") // case must match exactly
    expect(parseScreenAnnotation("inline")).toBe("inline")
  })
})

describe("parseScreenMode", () => {
  test("redact is the default; 'annotate' opts out", () => {
    expect(parseScreenMode(undefined)).toBe("redact")
    expect(parseScreenMode(false)).toBe("redact")
    expect(parseScreenMode("redact")).toBe("redact")
    expect(parseScreenMode("REDACT")).toBe("redact") // case must match exactly
    expect(parseScreenMode("annotate")).toBe("annotate")
  })
})

// Fixture deps for runScreen: fake judge/scrub, no plugin host.
const runScreenDeps = (answers: Record<string, number>) => ({
  judge: async () => ({
    answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { noul: v }])),
    cached: false,
  }),
  scrub: (text: string) => ({ text: text.replace(/sk-[a-z0-9]+/g, "REDACTED"), hits: 0 }),
})

describe("runScreen", () => {
  test("bands junk/injection into the shared verdict", async () => {
    const clean = await runScreen(runScreenDeps({ junk: 0.1, injection: 0.2 }), "fine")
    expect(clean.verdict).toBe("pass")
    expect(clean.verdictText).toBe("pass")
    const flagged = await runScreen(runScreenDeps({ junk: 0.6, injection: 0.2 }), "mid")
    expect(flagged.verdict).toBe("flagged")
    expect(flagged.verdictText).toContain("proceed with caution")
    const unsafe = await runScreen(runScreenDeps({ junk: 0.9, injection: 0.9 }), "bad")
    expect(unsafe.verdict).toBe("unsafe")
    expect(unsafe.verdictText).toContain("do not rely")
  })

  test("samples to SCREEN_SAMPLE_CHARS and reports scrub hits", async () => {
    let judged = ""
    const deps = {
      ...runScreenDeps({ junk: 0, injection: 0 }),
      scrub: (text: string) => {
        judged = text
        return { text, hits: text.length === 10 ? 2 : 0 }
      },
      maxChars: 10,
    }
    const outcome = await runScreen(deps, "0123456789EXTRA")
    expect(judged).toBe("0123456789")
    expect(outcome.scrubbedHits).toBe(2)
  })

  test("missing answers never fabricate a verdict", async () => {
    const deps = { judge: async () => undefined, scrub: (t: string) => ({ text: t, hits: 0 }) }
    const outcome = await runScreen(deps as any, "content")
    expect(outcome.verdict).toBe("pass")
    expect(outcome.junk).toBeUndefined()
    expect(outcome.injection).toBeUndefined()
  })
})

describe("screenVerdict", () => {
  test("pass below both thresholds", () => {
    expect(screenVerdict(0.1, 0.2)).toBe("pass")
    expect(screenVerdict(0.49, 0.49)).toBe("pass")
  })

  test("flagged at the 0.5 band", () => {
    expect(screenVerdict(0.5, 0.1)).toBe("flagged")
    expect(screenVerdict(0.1, 0.5)).toBe("flagged")
    expect(screenVerdict(0.6, 0.4)).toBe("flagged")
    expect(screenVerdict(0.4, 0.65)).toBe("flagged")
    expect(screenVerdict(0.84, 0.69)).toBe("flagged")
  })

  test("unsafe at the high thresholds", () => {
    expect(screenVerdict(0.9, 0.7)).toBe("unsafe")
    expect(screenVerdict(0.85, 0.0)).toBe("unsafe")
    expect(screenVerdict(0.0, 0.7)).toBe("unsafe")
  })

  test("non-numbers never verdict on their own", () => {
    expect(screenVerdict(undefined, undefined)).toBe("pass")
    expect(screenVerdict(null, "high")).toBe("pass")
  })
})

describe("parseScreenNotice", () => {
  const parse = (s: string) => parseScreenNotice(s)

  test("auto notice row with numbers and tool tail", () => {
    const item = parse("[jev-screen] junk=0.26 injection=0.20 pass - bash")
    expect(item?.verdict).toBe("pass")
    expect(item?.label).toBe("bash")
    expect(item?.junk).toBeCloseTo(0.26)
    expect(item?.injection).toBeCloseTo(0.2)
  })

  test("do-not-rely auto row reads unsafe", () => {
    const item = parse("[jev-screen] junk=0.9 injection=0.8 scrubbed=1 ⚠ do-not-rely - webfetch")
    expect(item?.verdict).toBe("unsafe")
    expect(item?.label).toBe("webfetch")
  })

  test("inline flagged notice", () => {
    const item = parse("[jev-screen] ⚠ https://x.test flagged (jev-screen: junk=0.6 injection=0.9) - result annotated, do not rely on it")
    expect(item?.verdict).toBe("flagged")
    expect(item?.label).toContain("x.test")
  })

  test("redact withheld row", () => {
    const item = parse("[jev-screen] ✗ https://x.test: content withheld (fail-closed) - jev-screen: junk=0.9 injection=0.9")
    expect(item?.verdict).toBe("unsafe")
    expect(item?.label).toBe("https://x.test")
    expect(item?.note).toContain("withheld")
  })

  test("command row with arrow verdict", () => {
    expect(parse("[jev-screen] https://y.test: junk=0.1 injection=0.2 → pass")?.verdict).toBe("pass")
    expect(parse("[jev-screen] https://y.test: junk=0.6 injection=0.2 → flagged - proceed with caution")?.verdict).toBe("flagged")
    expect(parse("[jev-screen] https://y.test: junk=0.9 injection=0.9 → FAIL - do not rely on this page; read manually")?.verdict).toBe("unsafe")
  })

  test("failures and non-rows are undefined", () => {
    expect(parse("[jev-screen] failed: endpoint refused")).toBeUndefined()
    expect(parse("[jev-error] something else")).toBeUndefined()
    expect(parse("plain text")).toBeUndefined()
  })
})
