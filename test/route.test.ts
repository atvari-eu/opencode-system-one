// Routing lattice tests: pure logic, no plugin host, no live jev.
// The judge is scripted; semantic quality against a real endpoint is a
// separate (offline, keyed) exercise - these fixtures pin the wiring:
// question building, option resolution, stand-downs, reverts.

import { describe, expect, test } from "bun:test"
import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  AUTO_REVIEW_MODEL,
  buildModelOptions,
  DEFAULT_POOL_SPLITS,
  buildPairOptions,
  candidateKey,
  type Candidate,
  effortModeFromLegacy,
  effortRoutingEnabled,
  parseEffortMode,
  resolveEffortMode,
  emergencyRealModel,
  isAvailableModel,
  MAX_OPTIONS,
  parseCandidates,
  parseRouteSources,
  pinMatches,
  pseudoEntryFor,
  refKey,
  resolveRouteAnswer,
  routableEffortLevels,
  routeDecision,
  routeTurn,
  type RouteConfig,
  type RouteInput,
  withoutSharedPool,
} from "../src/logic"

const LEVELS: Record<string, string[]> = {
  "acme/base": ["none", "low", "medium", "high"],
  "acme/fast": ["none", "low", "medium", "high"],
  "zeta/flagship": ["medium", "high", "xhigh"],
  "plain/litellm": [], // no reasoning variants listed
}

const levelsFor = async (providerID: string, modelID: string): Promise<string[]> =>
  LEVELS[`${providerID}/${modelID}`] ?? []

const CANDIDATES: Candidate[] = [
  { providerID: "acme", modelID: "fast", label: "cheap daily-driver model" },
  { providerID: "zeta", modelID: "flagship", label: "frontier model for heavy work" },
]

const PAIR_CONFIG: RouteConfig = {
  effort: true,
  model: true,
  candidates: CANDIDATES,
  effortMinConfidence: 0.6,
  modelMinConfidence: 0.6,
}

const MODEL_CONFIG: RouteConfig = { ...PAIR_CONFIG, effort: false }

const CURRENT = { providerID: "acme", modelID: "base", variant: "default" }

const turn = (config: RouteConfig, overrides: Partial<RouteInput> = {}): Promise<any> =>
  routeTurn(config, {
    prompt: "fix the flaky test",
    current: CURRENT,
    levelsFor,
    judge: async () => ({ answers: { route: { choice: "acme/base#default", confidence: 0.9 } } }),
    ...overrides,
  })

describe("parseCandidates", () => {
  test("accepts provider/model strings, first slash splits", () => {
    expect(parseCandidates(["openrouter/anthropic/claude-x", "acme/fast"])).toEqual([
      { providerID: "openrouter", modelID: "anthropic/claude-x" },
      { providerID: "acme", modelID: "fast" },
    ])
  })

  test("accepts objects with optional labels, drops garbage", () => {
    expect(
      parseCandidates([
        { providerID: "acme", modelID: "fast", label: "cheap" },
        { providerID: "", modelID: "x" },
        { providerID: "acme", modelID: " " },
        "no-slash",
        42,
        null,
      ]),
    ).toEqual([{ providerID: "acme", modelID: "fast", label: "cheap" }])
  })

  test("non-arrays parse to empty", () => {
    expect(parseCandidates(undefined)).toEqual([])
    expect(parseCandidates("acme/fast")).toEqual([])
  })
})

describe("manual-pick lattice", () => {
  const to = { providerID: "acme", id: "base", variant: "high" }
  const from = { providerID: "acme", id: "base", variant: "default" }
  const pin = { to, from }
  const foreign = { to: { providerID: "zeta", id: "flagship" }, from }

  test("own switch matches the pin (order-insensitive variant case)", () => {
    expect(pinMatches({ to: { ...to, variant: "HIGH" }, from }, pin)).toBe(true)
    expect(pinMatches({ to, from }, pin)).toBe(true)
  })

  test("no switch -> go; pin-matched switch -> go; foreign -> stand", () => {
    expect(routeDecision(undefined, pin, "acme/base")).toBe("go")
    expect(routeDecision({ to, from }, pin, "acme/base")).toBe("go")
    expect(routeDecision(foreign, pin, "acme/base")).toBe("stand")
    expect(routeDecision(foreign, undefined, "acme/base")).toBe("stand")
  })

  test("foreign pick back at base -> rearm", () => {
    expect(routeDecision({ to, from }, pin, "acme/base") === "go").toBe(true)
    const userAtBase = { to: { providerID: "acme", id: "base", variant: "medium" }, from }
    expect(routeDecision(userAtBase, undefined, "acme/base")).toBe("rearm")
  })
})

describe("pair option building", () => {
  test("current levels first, then candidates; default pair for no-variant models", () => {
    const built = buildPairOptions(
      { providerID: "acme", modelID: "base", variant: "default" },
      LEVELS["acme/base"]!,
      [
        { candidate: { providerID: "acme", modelID: "fast", label: "fast" }, levels: LEVELS["acme/fast"]! },
        { candidate: { providerID: "plain", modelID: "litellm" }, levels: [] },
      ],
    )
    expect(built.options.map((o) => o.key)).toEqual([
      "acme/base#none",
      "acme/base#low",
      "acme/base#medium",
      "acme/base#high",
      "acme/fast#none",
      "acme/fast#low",
      "acme/fast#medium",
      "acme/fast#high",
      "plain/litellm#default",
    ])
    expect(built.included).toEqual([
      { providerID: "acme", modelID: "fast", label: "fast" },
      { providerID: "plain", modelID: "litellm" },
    ])
  })

  test("every candidate gets a level before extras consume the cap", () => {
    const many: Array<{ candidate: Candidate; levels: string[] }> = Array.from({ length: 5 }, (_, i) => ({
      candidate: { providerID: "p", modelID: `m${i}` },
      levels: ["low", "medium", "high"],
    }))
    const built = buildPairOptions({ providerID: "c", modelID: "cur", variant: "default" }, ["low", "medium"], many)
    expect(built.options.length).toBeLessThanOrEqual(MAX_OPTIONS)
    // 2 current + 5 reserved levels: every candidate survives with a base
    // level, and the leftover room goes to the earlier candidates' extras.
    expect(built.included.map((c) => c.modelID)).toEqual(["m0", "m1", "m2", "m3", "m4"])
    const levelsOf = (modelID: string): string[] =>
      built.options.filter((o) => o.modelID === modelID).map((o) => o.variant ?? "")
    expect(levelsOf("m0")).toEqual(["low", "medium", "high"])
    expect(levelsOf("m1")).toEqual(["low", "medium", "high"])
    expect(levelsOf("m2")).toEqual(["medium", "low"])
    expect(levelsOf("m3")).toEqual(["medium"])
    expect(levelsOf("m4")).toEqual(["medium"])
  })
})

describe("routableEffortLevels", () => {
  test("drops the host's thinking-off toggle id", () => {
    expect(routableEffortLevels(["none", "thinking", "low", "medium"])).toEqual(["low", "medium"])
    expect(routableEffortLevels(["none"])).toEqual([])
    expect(routableEffortLevels([])).toEqual([])
  })

  test("keeps catalog order and ignores ids that are not effort levels", () => {
    expect(routableEffortLevels(["max", "thinking", "minimal", "high"])).toEqual(["minimal", "high", "max"])
  })
})

describe("model-only option building", () => {
  test("current model first, tier hints ride into criteria", () => {
    const options = buildModelOptions({ providerID: "acme", modelID: "base" }, CANDIDATES, () => "$2.00/Mtok input")
    expect(options.map((o) => o.key)).toEqual(["acme/base", "acme/fast", "zeta/flagship"])
    expect(options[0]!.criteria).toContain("$2.00/Mtok input")
    expect(options[1]!.criteria).toContain("cheap daily-driver model")
  })
})

describe("answer resolution", () => {
  const options = buildPairOptions(
    { providerID: "acme", modelID: "base", variant: "default" },
    ["low", "medium"],
    [{ candidate: CANDIDATES[0]!, levels: ["high"] }],
  ).options

  test("resolves an offered pair", () => {
    expect(resolveRouteAnswer({ choice: "acme/base#low", confidence: 0.9 }, options)).toEqual({
      target: { providerID: "acme", modelID: "base", variant: "low" },
    })
  })

  test("resolves case-insensitively and trimmed", () => {
    expect(resolveRouteAnswer({ choice: "  ACME/FAST#HIGH  " }, options)).toEqual({
      target: { providerID: "acme", modelID: "fast", variant: "high" },
    })
  })

  test("unknown or missing options are errors, never decisions", () => {
    expect(resolveRouteAnswer({ choice: "acme/base#xhigh" }, options)).toHaveProperty("error")
    expect(resolveRouteAnswer({ choice: "" }, options)).toHaveProperty("error")
    expect(resolveRouteAnswer(undefined, options)).toHaveProperty("error")
  })
})

describe("routeTurn: legacy effort flow (model routing off)", () => {
  const config: RouteConfig = { ...PAIR_CONFIG, model: false, candidates: [] }

  test("picks a level and records a variant-only pin", async () => {
    const outcome = await turn(config, {
      judge: async () => ({ answers: { effort: { choice: "high", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toEqual({ providerID: "acme", modelID: "base", variant: "high" })
    expect(outcome.recordPin).toEqual({
      to: { providerID: "acme", id: "base", variant: "high" },
      from: { providerID: "acme", id: "base", variant: "default" },
    })
  })

  test("picking the current variant is a no-op", async () => {
    const outcome = await turn(config, {
      current: { providerID: "acme", modelID: "base", variant: "medium" },
      judge: async () => ({ answers: { effort: { choice: "MEDIUM", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.recordPin).toBeUndefined()
  })

  test("foreign pick stands down with no jev call; back to Default re-arms", async () => {
    let calls = 0
    const stand = await turn(config, {
      lastSwitch: { to: { providerID: "acme", id: "base", variant: "low" }, from: { providerID: "acme", id: "base" } },
      judge: async () => {
        calls++
        return { answers: {} }
      },
    })
    expect(stand.mode).toBe("stand")
    expect(calls).toBe(0)
    const rearm = await turn(config, {
      lastSwitch: { to: { providerID: "acme", id: "base", variant: "default" }, from: { providerID: "acme", id: "base" } },
    })
    expect(rearm.mode).toBe("rearm")
  })

  test("malformed answers keep the current variant", async () => {
    const outcome = await turn(config, {
      judge: async () => ({ answers: { effort: { choice: "banana", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.logs.some((l: string) => l.includes("uninterpretable"))).toBe(true)
    // An answers-carrying but unusable reply is not an API fault - only a
    // failed call (throw, no-answer body) surfaces one.
    expect(outcome.apiFaults).toBeUndefined()
  })

  test("effort judge failure keeps the level and carries the API fault", async () => {
    const outcome = await turn(config, {
      current: { providerID: "acme", modelID: "base", variant: "medium" },
      judge: async () => {
        throw new Error("jev: 401 - credential rejected")
      },
    })
    expect(outcome.errors.some((line: string) => line.includes("effort: judge failed"))).toBe(true)
    expect(outcome.apiFaults).toEqual(["jev: 401 - credential rejected"])
  })
})

describe("routeTurn: pair mode (effort + model)", () => {
  test("digest is wrapped into the state and scrubbed", async () => {
    const seen: unknown[] = []
    await turn(PAIR_CONFIG, {
      digest: "token-sk_[redacted] RECENT HEAVY WORK",
      judge: async (_questions: unknown, state: unknown) => {
        seen.push(state)
        return { answers: { route: { choice: "acme/base#default", confidence: 0.9 } } }
      },
      scrub: (t: string) => t.replaceAll("sk_", "REDACTED_"),
    })
    const text = JSON.stringify(seen)
    expect(text).toContain("<recent-context>")
    expect(text).toContain("token-REDACTED_")
    expect(text).toContain("RECENT HEAVY WORK")
  })

  test("no digest keeps the prompt-only state", async () => {
    const seen: unknown[] = []
    await turn(PAIR_CONFIG, {
      judge: async (_questions: unknown, state: unknown) => {
        seen.push(state)
        return { answers: { route: { choice: "acme/base#default", confidence: 0.9 } } }
      },
    })
    const text = JSON.stringify(seen)
    expect(text).not.toContain("<recent-context>")
  })

  test("routes to a candidate model+level and records the pin", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      judge: async () => ({ answers: { route: { choice: "zeta/flagship#high", confidence: 0.9 } } }),
    })
    expect(outcome.mode).toBe("pair")
    expect(outcome.switchTo).toEqual({ providerID: "zeta", modelID: "flagship", variant: "high" })
    expect(outcome.recordPin).toEqual({
      to: { providerID: "zeta", id: "flagship", variant: "high" },
      from: { providerID: "acme", id: "base", variant: "default" },
    })
  })

  test("picking the current pair is a silent keep", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      current: { providerID: "acme", modelID: "base", variant: "medium" },
      judge: async () => ({ answers: { route: { choice: "acme/base#medium", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.recordPin).toBeUndefined()
    expect(outcome.logs).toEqual([])
  })

  test("low confidence keeps the session as-is (no revert)", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      judge: async () => ({ answers: { route: { choice: "zeta/flagship#high", confidence: 0.4 } } }),
    })
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.logs.some((l: string) => l.includes("uncertain"))).toBe(true)
  })

  test("own switch + judge failure reverts to base", async () => {
    const routed = { providerID: "zeta", id: "flagship", variant: "xhigh" }
    const origin = { providerID: "acme", id: "base", variant: "default" }
    const outcome = await turn(PAIR_CONFIG, {
      current: { providerID: "zeta", modelID: "flagship", variant: "xhigh" },
      pin: { to: routed, from: origin },
      lastSwitch: { to: routed, from: origin },
      base: { providerID: "acme", modelID: "base", variant: "default" },
      judge: async () => {
        throw new Error("endpoint down")
      },
    })
    expect(outcome.switchTo).toEqual({ providerID: "acme", modelID: "base" }) // "default" variant drops out
    expect(outcome.recordPin).toEqual({
      to: { providerID: "acme", id: "base" },
      from: { providerID: "zeta", id: "flagship", variant: "xhigh" },
    })
    expect(outcome.errors.some((l: string) => l.includes("reverting to acme/base"))).toBe(true)
  })

  test("judge failure at base never switches and carries the API fault", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      judge: async () => {
        throw new Error("endpoint down")
      },
    })
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.recordPin).toBeUndefined()
    expect(outcome.apiFaults).toEqual(["endpoint down"])
  })

  test("judge failure without an own switch never switches", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      lastSwitch: { to: { providerID: "user", id: "pick", variant: "high" }, from: { providerID: "acme", id: "base" } },
      judge: async () => {
        throw new Error("endpoint down")
      },
    })
    // The foreign pick stands down before jev is even reached - no judge call,
    // no API fault.
    expect(outcome.mode).toBe("stand")
    expect(outcome.apiFaults).toBeUndefined()
  })

  test("a reply without answers is an API fault that reverts to base", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      judge: async () => ({}),
    })
    expect(outcome.errors.some((line: string) => line.includes("malformed response"))).toBe(true)
    expect(outcome.apiFaults).toEqual(["[jev] route: malformed response (no answers)"])
  })

  test("uninterpretable pair answers are failures, reverting an own switch", async () => {
    const routed = { providerID: "zeta", id: "flagship", variant: "xhigh" }
    const origin = { providerID: "acme", id: "base", variant: "default" }
    const outcome = await turn(PAIR_CONFIG, {
      current: { providerID: "zeta", modelID: "flagship", variant: "xhigh" },
      pin: { to: routed, from: origin },
      lastSwitch: { to: routed, from: origin },
      base: { providerID: "acme", modelID: "base", variant: "default" },
      judge: async () => ({ answers: { route: { choice: "nope#nope", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toEqual({ providerID: "acme", modelID: "base" })
  })

  test("back at base re-arms and judges normally", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      lastSwitch: { to: { providerID: "acme", id: "base", variant: "high" }, from: { providerID: "zeta", id: "flagship" } },
      judge: async () => ({ answers: { route: { choice: "acme/base#low", confidence: 0.9 } } }),
    })
    expect(outcome.mode).toBe("pair")
    expect(outcome.switchTo).toEqual({ providerID: "acme", modelID: "base", variant: "low" })
  })
})

describe("routeTurn: model-only mode (effort off)", () => {
  test("keeps the current model when jev says so", async () => {
    const outcome = await turn(MODEL_CONFIG, {
      judge: async () => ({ answers: { route: { choice: "acme/base", confidence: 0.9 } } }),
    })
    expect(outcome.mode).toBe("model")
    expect(outcome.switchTo).toBeUndefined()
  })

  test("switches to candidates without forcing a variant", async () => {
    const outcome = await turn(MODEL_CONFIG, {
      judge: async () => ({ answers: { route: { choice: "zeta/flagship", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toEqual({ providerID: "zeta", modelID: "flagship" })
    expect(outcome.recordPin).toEqual({
      to: { providerID: "zeta", id: "flagship" },
      from: { providerID: "acme", id: "base", variant: "default" },
    })
  })
})

describe("scrub and state hygiene", () => {
  test("prompts are scrubbed before judging", async () => {
    const seen: string[] = []
    await turn(PAIR_CONFIG, {
      prompt: "run deploy with API_KEY=sk-abc123def456ghi789jkl012 please",
      scrub: (t: string) => t.replace(/sk-\w+/, "[REDACTED]"),
      judge: async (_q, state) => {
        seen.push(String(state))
        return { answers: { route: { choice: "acme/base", confidence: 0.9 } } }
      },
    })
    expect(seen[0]).toContain("[REDACTED]")
    expect(seen[0]).not.toContain("sk-abc123")
  })
})

describe("candidate model facts", () => {
  const FACTS = new Map<string, { providerID: string; modelID: string; contextTokens?: number }>([
    ["acme/base", { providerID: "acme", modelID: "base", contextTokens: 128_000 }],
    ["zeta/flagship", { providerID: "zeta", modelID: "flagship", contextTokens: 1_000_000 }],
  ])
  const factsOf = (providerID: string, modelID: string) => FACTS.get(`${providerID}/${modelID}`)

  test("the block rides after the state and lists each model once", async () => {
    const seen: string[] = []
    await turn(PAIR_CONFIG, {
      digest: "RECENT HEAVY WORK",
      facts: factsOf,
      judge: async (_q: unknown, state: unknown) => {
        seen.push(String(state))
        return { answers: { route: { choice: "acme/base#default", confidence: 0.9 } } }
      },
    })
    const state = seen.join("")
    expect(state).toContain("<recent-context>")
    expect(state.indexOf("<candidate-models>")).toBeGreaterThan(state.indexOf("</recent-context>"))
    expect(state.match(/- acme\/base:/g)?.length).toBe(1)
    expect(state.match(/- zeta\/flagship:/g)?.length).toBe(1)
  })

  test("no facts callback keeps the state exactly as before", async () => {
    const seen: string[] = []
    await turn(PAIR_CONFIG, {
      judge: async (_q: unknown, state: unknown) => {
        seen.push(String(state))
        return { answers: { route: { choice: "acme/base#default", confidence: 0.9 } } }
      },
    })
    expect(seen.join("")).not.toContain("<candidate-models>")
  })

  test("facts cannot reintroduce unscrubbed prompt text", async () => {
    const seen: string[] = []
    await turn(MODEL_CONFIG, {
      prompt: "use token sk_live_123",
      scrub: (t: string) => t.replaceAll("sk_live_123", "[redacted]"),
      facts: (p: string, m: string) => ({ providerID: p, modelID: m, contextTokens: 128_000 }),
      judge: async (_q: unknown, state: unknown) => {
        seen.push(String(state))
        return { answers: { route: { choice: "acme/base", confidence: 0.9 } } }
      },
    })
    expect(seen.join("")).toContain("<candidate-models>")
    expect(seen.join("")).not.toContain("sk_live_123")
  })
})

// ---------------------------------------------------------------------------
// Offline fixtures: one scripted judge reply per prompt, asserting the resolved
// (model, level). The mock encodes the pick itself - these pin the wiring end
// to end (options -> answer -> switch + pin) so a live-jev eval only has to
// swap the judge.
// ---------------------------------------------------------------------------

const FIXTURES: Array<{ prompt: string; pick: string }> = [
  { prompt: "rename the variable x to y in config.ts", pick: "acme/base#low" },
  { prompt: "what does the env var JEV_ENDPOINT default to?", pick: "acme/base#none" },
  { prompt: "please fix the flaky CI test in the release pipeline", pick: "acme/base#medium" },
  { prompt: "refactor storage into a repository layer across the codebase", pick: "acme/fast#medium" },
  { prompt: "debug why the websocket drops under load; be careful, prod depends on it", pick: "zeta/flagship#xhigh" },
  { prompt: "design the new compaction storage engine and write the RFC", pick: "zeta/flagship#high" },
  { prompt: "add a comment above this function", pick: "acme/fast#none" },
  { prompt: "run the tests and report failures", pick: "acme/fast#low" },
  { prompt: "migrate us off the deprecated SDK before Friday; the whole deploy depends on it", pick: "zeta/flagship#xhigh" },
  { prompt: "summarize what changed in this session", pick: "acme/base#low" },
  { prompt: "trace the deadlock in the scheduler and propose a fix", pick: "zeta/flagship#high" },
  { prompt: "update the README to document the new options", pick: "acme/base#low" },
]

describe("offline routing fixtures", () => {
  for (const fixture of FIXTURES) {
    test(`"${fixture.prompt.slice(0, 40)}" resolves to ${fixture.pick}`, async () => {
      const outcome = await turn(PAIR_CONFIG, {
        prompt: fixture.prompt,
        judge: async () => ({ answers: { route: { choice: fixture.pick, confidence: 0.9 } } }),
      })
      const [modelPart = "", variant] = fixture.pick.split("#")
      const slash = modelPart.indexOf("/")
      expect(outcome.switchTo).toEqual({
        providerID: modelPart.slice(0, slash),
        modelID: modelPart.slice(slash + 1),
        ...(variant ? { variant } : {}),
      })
      expect(outcome.recordPin).toBeDefined()
    })
  }
})

// ---------------------------------------------------------------------------
// Dynamic routing sources (route.sources): parsing + usage ranking.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auto pseudo-model entry (route.autoModel): pure-logic wiring fixtures.
// ---------------------------------------------------------------------------

describe("auto pseudo-model entry", () => {
  const AUTO = { providerID: "system-one", modelID: "auto" }
  const AUTO_CURRENT = { providerID: "system-one", modelID: "auto", variant: "default" }

  test("auto entry: options are candidate pairs only (no stay-on-auto choice)", async () => {
    const criteriaKeys: string[] = []
    await turn(PAIR_CONFIG, {
      current: AUTO_CURRENT,
      autoEntry: AUTO,
      levelsFor: async (p, m) => (p === "system-one" ? [] : (LEVELS[`${p}/${m}`] ?? [])),
      judge: async (questions: any) => {
        criteriaKeys.push(...Object.keys(questions[0].criteria))
        return { answers: { route: { choice: "acme/fast#low", confidence: 0.9 } } }
      },
    })
    expect(criteriaKeys).toEqual([
      "acme/fast#none",
      "acme/fast#low",
      "acme/fast#medium",
      "acme/fast#high",
      "zeta/flagship#medium",
      "zeta/flagship#high",
      "zeta/flagship#xhigh",
    ])
  })

  test("auto entry: pick switches to the pair, pin from the entry", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      current: AUTO_CURRENT,
      autoEntry: AUTO,
      base: AUTO,
      levelsFor: async (p, m) => (p === "system-one" ? [] : (LEVELS[`${p}/${m}`] ?? [])),
      judge: async () => ({ answers: { route: { choice: "zeta/flagship#high", confidence: 0.9 } } }),
    })
    expect(outcome.switchTo).toEqual({ providerID: "zeta", modelID: "flagship", variant: "high" })
    expect(outcome.recordPin).toEqual({
      to: { providerID: "zeta", id: "flagship", variant: "high" },
      from: { providerID: "system-one", id: "auto", variant: "default" },
    })
  })

  test("mid-loop judge failure keeps the pick (never reverts back to auto)", async () => {
    const last = {
      to: { providerID: "zeta", id: "flagship", variant: "high" },
      from: { providerID: "system-one", id: "auto" },
    }
    const outcome = await turn(PAIR_CONFIG, {
      current: { providerID: "zeta", modelID: "flagship", variant: "high" },
      autoEntry: AUTO,
      base: AUTO,
      lastSwitch: last,
      pin: last,
      judge: async () => {
        throw new Error("boom")
      },
    })
    expect(outcome.mode).toBe("model")
    expect(outcome.switchTo).toBeUndefined()
    expect(outcome.errors.some((e: string) => e.includes("boom"))).toBe(true)
  })

  test("at the entry, judge failure keeps auto (adapter decides about fallback)", async () => {
    const outcome = await turn(PAIR_CONFIG, {
      current: AUTO_CURRENT,
      autoEntry: AUTO,
      base: AUTO,
      judge: async () => {
        throw new Error("boom")
      },
    })
    expect(outcome.mode).toBe("model")
    expect(outcome.switchTo).toBeUndefined()
  })
})

describe("auto and auto-review entries", () => {
  const entries = [
    { providerID: AUTO_PROVIDER, modelID: AUTO_MODEL },
    { providerID: AUTO_PROVIDER, modelID: AUTO_REVIEW_MODEL },
  ]

  test("entry matching is exact, never by provider alone", () => {
    expect(pseudoEntryFor(entries, { providerID: AUTO_PROVIDER, id: AUTO_MODEL })?.modelID).toBe(AUTO_MODEL)
    expect(pseudoEntryFor(entries, { providerID: AUTO_PROVIDER, id: AUTO_REVIEW_MODEL })?.modelID).toBe(
      AUTO_REVIEW_MODEL,
    )
    expect(pseudoEntryFor(entries, { providerID: AUTO_PROVIDER, id: "something-else" })).toBeNull()
    expect(pseudoEntryFor(entries, { providerID: "acme", id: AUTO_MODEL })).toBeNull()
  })

  test("review pool never contains a model from the auto pool", () => {
    const autoPool: Candidate[] = [
      { providerID: "acme", modelID: "fast" },
      { providerID: "zeta", modelID: "flagship" },
    ]
    const reviewPool: Candidate[] = [
      { providerID: "acme", modelID: "fast" },
      { providerID: "review", modelID: "deep" },
    ]
    expect(withoutSharedPool(reviewPool, autoPool)).toEqual([{ providerID: "review", modelID: "deep" }])
  })

  test("review criteria replace the cost-first auto criteria", async () => {
    let instructions = ""
    let state = ""
    await turn(PAIR_CONFIG, {
      review: true,
      judge: async (questions: any, judgedState: any) => {
        instructions = questions[0].instructions
        state = String(judgedState)
        return { answers: { route: { choice: "acme/fast#low", confidence: 0.9 } } }
      },
    })
    expect(instructions).toContain("REVIEW turn")
    expect(instructions).toContain("Prioritize correctness")
    expect(state).toContain("review routing entry")
  })

  test("model-only review routing also uses review criteria", async () => {
    let instructions = ""
    await turn(MODEL_CONFIG, {
      review: true,
      judge: async (questions: any) => {
        instructions = questions[0].instructions
        return { answers: { route: { choice: "acme/base", confidence: 0.9 } } }
      },
    })
    expect(instructions).toContain("REVIEW turn")
    expect(instructions).toContain("Prioritize correctness")
  })
})

// ---------------------------------------------------------------------------
// parseRouteSources: dynamic candidate sources (favorites + shared pool).
// ---------------------------------------------------------------------------

describe("parseRouteSources", () => {
  test("everything is off by default and for malformed shapes", () => {
    for (const raw of [undefined, null, true, "x", 7, [], {}]) {
      const cfg = parseRouteSources(raw)
      expect(cfg.favorites).toBe(false)
      expect(cfg.pool).toBe("auto")
    }
  })

  test("favorites only turns on with an explicit true", () => {
    expect(parseRouteSources({ favorites: true }).favorites).toBe(true)
    expect(parseRouteSources({ favorites: "yes" }).favorites).toBe(false)
    expect(parseRouteSources({ favorites: 1 }).favorites).toBe(false)
  })

  test("a stale opencode source is ignored", () => {
    expect(parseRouteSources({ opencode: true }).favorites).toBe(false)
    expect(parseRouteSources({ opencode: { plan: "go", local: true } }).favorites).toBe(false)
    expect(parseRouteSources({ opencode: { plan: "go", local: true } }).pool).toBe("auto")
  })

  test("pool selects the Console pool", () => {
    expect(parseRouteSources({ pool: true }).pool).toBe("on")
    expect(parseRouteSources({ pool: false }).pool).toBe("off")
    expect(parseRouteSources({ pool: "auto" }).pool).toBe("auto")
    expect(parseRouteSources({ pool: "yes" }).pool).toBe("off")
  })

  test("an object inlines this entry's cut over the kind defaults", () => {
    const cfg = parseRouteSources({ pool: { strong: 2 } }, "review")
    expect(cfg.pool).toBe("own")
    expect(cfg.poolConfig).toEqual({ ...DEFAULT_POOL_SPLITS.review, strong: 2 })
    expect(parseRouteSources({ pool: {} }).poolConfig).toEqual(DEFAULT_POOL_SPLITS.default)
    expect(parseRouteSources({ pool: 7 }).pool).toBe("auto")
    expect(parseRouteSources({ pool: 7 }).poolConfig).toBeNull()
  })

  test("pool and favorites compose independently", () => {
    const cfg = parseRouteSources({ favorites: true, pool: false })
    expect(cfg.favorites).toBe(true)
    expect(cfg.pool).toBe("off")
  })
})

// ---------------------------------------------------------------------------
// Session availability gate for routing candidates (catalog-flag based).
// ---------------------------------------------------------------------------

describe("isAvailableModel", () => {
  test("healthy active entries pass", () => {
    expect(isAvailableModel({ enabled: true, status: "active" })).toBe(true)
    // Older catalogs may omit both flags - fail open.
    expect(isAvailableModel({})).toBe(true)
  })

  test("explicitly disabled or deprecated entries fail", () => {
    expect(isAvailableModel({ enabled: false, status: "active" })).toBe(false)
    expect(isAvailableModel({ enabled: true, status: "deprecated" })).toBe(false)
    expect(isAvailableModel({ enabled: true, status: "Disabled" })).toBe(false)
    expect(isAvailableModel({ enabled: true, status: "retired" })).toBe(false)
    expect(isAvailableModel({ enabled: true, status: "active", time: { released: 123, deprecated: 456 } })).toBe(false)
  })

  test("statuses fail open, non-entries fail closed", () => {
    for (const status of ["beta", "preview", "experimental", "stable", ""]) {
      expect(isAvailableModel({ enabled: true, status })).toBe(true)
    }
    expect(isAvailableModel(null)).toBe(false)
    expect(isAvailableModel(undefined)).toBe(false)
    expect(isAvailableModel("active")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Emergency fallback: the last real model a session actually ran, used to
// guarantee the auto entry is never the platform of an actual turn.
// ---------------------------------------------------------------------------

describe("emergencyRealModel", () => {
  const PSEUDO = "opencode-decisions"

  test("prefers the pin's parked-from ref (id spelling drops default variant)", () => {
    const rows = [{ type: "model-switched", model: { providerID: "zeta", id: "flagship" } }]
    expect(
      emergencyRealModel(rows, PSEUDO, {
        to: { providerID: PSEUDO, id: "auto" },
        from: { providerID: "acme", id: "base", variant: "default" },
      }),
    ).toEqual({ providerID: "acme", modelID: "base" })
  })

  test("keeps non-default pin variants", () => {
    expect(
      emergencyRealModel([], PSEUDO, {
        to: { providerID: PSEUDO, id: "auto" },
        from: { providerID: "delta", id: "zai-org/glm-5.3-flash", variant: "medium" },
      }),
    ).toEqual({ providerID: "delta", modelID: "zai-org/glm-5.3-flash", variant: "medium" })
  })

  test("skips a pin parked from the pseudo form itself, falls back to rows", () => {
    // Defensive re-park chains can store the entry as the from-ref; the
    // newest real switch row is then the truth.
    const rows = [
      { type: "user", text: "why" },
      { type: "model-switched", model: { providerID: PSEUDO, id: "auto" }, previous: { providerID: "old", id: "gone" } },
      { info: { type: "model-switched", model: { providerID: "acme", id: "fast", variant: "high" } } },
    ]
    expect(emergencyRealModel(rows, PSEUDO, { to: { providerID: PSEUDO, id: "auto" }, from: { providerID: PSEUDO, id: "auto" } })).toEqual({
      providerID: "acme",
      modelID: "fast",
      variant: "high",
    })
  })

  test("scans newest-first and ignores non-switch rows and pseudo targets", () => {
    const rows = [
      { type: "assistant" },
      { type: "model-switched", model: { providerID: "acme", id: "fast" } },
      { type: "model-switched", model: { providerID: PSEUDO, id: "auto" } },
    ]
    expect(emergencyRealModel(rows, PSEUDO, null)).toEqual({ providerID: "acme", modelID: "fast" })
  })

  test("undefined when nothing real is known and accepts both ref spellings", () => {
    expect(emergencyRealModel([], PSEUDO, null)).toBeUndefined()
    expect(emergencyRealModel([], PSEUDO, { to: { providerID: PSEUDO, id: "auto" }, from: { providerID: PSEUDO, id: "auto" } })).toBeUndefined()
    expect(
      emergencyRealModel([{ type: "model-switched", model: { providerID: "acme", modelID: "fast" } }], PSEUDO),
    ).toEqual({ providerID: "acme", modelID: "fast" })
    expect(emergencyRealModel([], PSEUDO, undefined)).toBeUndefined()
  })
})

describe("parseEffortMode", () => {
  test("defaults to pair mode", () => {
    expect(parseEffortMode(undefined)).toBe("pair")
    expect(parseEffortMode("pair")).toBe("pair")
    expect(parseEffortMode("bogus")).toBe("pair")
  })

  test("accepts the string modes", () => {
    expect(parseEffortMode("always")).toBe("always")
    expect(parseEffortMode("off")).toBe("off")
  })
})

describe("resolveEffortMode", () => {
  test("defaults to pair without a warning", () => {
    expect(resolveEffortMode(undefined)).toEqual({ mode: "pair" })
    expect(resolveEffortMode({})).toEqual({ mode: "pair" })
  })

  test("mode wins over the deprecated auto flag", () => {
    expect(resolveEffortMode({ mode: "off", auto: true })).toEqual({ mode: "off" })
    expect(resolveEffortMode({ mode: "always", auto: false })).toEqual({ mode: "always" })
  })

  test("an unknown mode falls back to pair and warns", () => {
    expect(resolveEffortMode({ mode: "alwyas" })).toEqual({
      mode: "pair",
      warning: `"mode" must be "pair", "always", or "off" - using "pair"`,
    })
  })

  test("legacy auto maps when mode is absent", () => {
    expect(resolveEffortMode({ auto: true })).toEqual({ mode: "always" })
    expect(resolveEffortMode({ auto: false })).toEqual({ mode: "off" })
  })
})

describe("effortModeFromLegacy", () => {
  test("maps the deprecated effort.auto boolean", () => {
    expect(effortModeFromLegacy(true)).toBe("always")
    expect(effortModeFromLegacy(false)).toBe("off")
    expect(effortModeFromLegacy(undefined)).toBeUndefined()
  })
})

describe("effortRoutingEnabled", () => {
  test("pair routes effort on entry turns only", () => {
    expect(effortRoutingEnabled("pair", true)).toBe(true)
    expect(effortRoutingEnabled("pair", false)).toBe(false)
  })

  test("always routes effort everywhere", () => {
    expect(effortRoutingEnabled("always", true)).toBe(true)
    expect(effortRoutingEnabled("always", false)).toBe(true)
  })

  test("off opts every turn out", () => {
    expect(effortRoutingEnabled("off", true)).toBe(false)
    expect(effortRoutingEnabled("off", false)).toBe(false)
  })
})
