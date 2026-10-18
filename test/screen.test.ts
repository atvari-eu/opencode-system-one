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
