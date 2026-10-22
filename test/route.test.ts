// Routing lattice tests: pure logic, no plugin host, no live jev.
// The judge is scripted; semantic quality against a real endpoint is a
// separate (offline, keyed) exercise - these fixtures pin the wiring:
// question building, option resolution, stand-downs, reverts.

import { describe, expect, test } from "bun:test"
import {
  buildModelOptions,
  buildPairOptions,
  candidateKey,
  type Candidate,
  emergencyRealModel,
  isAvailableModel,
  MAX_OPTIONS,
  parseCandidates,
  parseRouteSources,
  pinMatches,
  rankSourcePopular,
  refKey,
  resolveRouteAnswer,
  routeDecision,
  routeTurn,
  type RouteConfig,
  type RouteInput,
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
      LEVELS["acme/base"],
      [
        { candidate: { providerID: "acme", modelID: "fast", label: "fast" }, levels: LEVELS["acme/fast"] },
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

  test("candidates are dropped whole past the option cap, never trimmed", () => {
    const many: Array<{ candidate: Candidate; levels: string[] }> = Array.from({ length: 5 }, (_, i) => ({
      candidate: { providerID: "p", modelID: `m${i}` },
      levels: ["low", "medium", "high"],
    }))
    const built = buildPairOptions({ providerID: "c", modelID: "cur", variant: "default" }, ["low", "medium"], many)
    expect(built.options.length).toBeLessThanOrEqual(MAX_OPTIONS)
    // 2 current + 3 levels per candidate: fits 3 candidates, drops the rest
    expect(built.included.map((c) => c.modelID)).toEqual(["m0", "m1", "m2"])
    // no partial level lists: every included candidate contributes all its levels
    for (const c of built.included) {
      const keys = built.options.filter((o) => o.providerID === c.providerID && o.modelID === c.modelID)
      expect(keys.map((o) => o.variant)).toEqual(["low", "medium", "high"])
    }
  })
})

describe("model-only option building", () => {
  test("current model first, tier hints ride into criteria", () => {
    const options = buildModelOptions({ providerID: "acme", modelID: "base" }, CANDIDATES, () => "$2.00/Mtok input")
    expect(options.map((o) => o.key)).toEqual(["acme/base", "acme/fast", "zeta/flagship"])
    expect(options[0].criteria).toContain("$2.00/Mtok input")
    expect(options[1].criteria).toContain("cheap daily-driver model")
  })
})

describe("answer resolution", () => {
  const options = buildPairOptions(
    { providerID: "acme", modelID: "base", variant: "default" },
    ["low", "medium"],
    [{ candidate: CANDIDATES[0], levels: ["high"] }],
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
      const [modelPart, variant] = fixture.pick.split("#")
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

// ---------------------------------------------------------------------------
// parseRouteSources: dynamic candidate sources (favorites + opencode usage).
// ---------------------------------------------------------------------------

describe("parseRouteSources", () => {
  test("everything is off by default and for malformed shapes", () => {
    for (const raw of [undefined, null, true, "x", 7, [], {}]) {
      const cfg = parseRouteSources(raw)
      expect(cfg.favorites).toBe(false)
      expect(cfg.opencode.enabled).toBe(false)
      expect(cfg.opencode.plan).toBe("zen")
      expect(cfg.opencode.limit).toBe(10)
    }
  })

  test("favorites only turns on with an explicit true", () => {
    expect(parseRouteSources({ favorites: true }).favorites).toBe(true)
    expect(parseRouteSources({ favorites: "yes" }).favorites).toBe(false)
    expect(parseRouteSources({ favorites: 1 }).favorites).toBe(false)
  })

  test("opencode: true enables popular mode on the zen plan by default", () => {
    const on = parseRouteSources({ opencode: true })
    expect(on.opencode).toEqual({ enabled: true, plan: "zen", limit: 10 })
  })

  test("popular is the default mode; a count sets the top size", () => {
    expect(parseRouteSources({ opencode: {} }).opencode).toEqual({ enabled: true, plan: "zen", limit: 10 })
    expect(parseRouteSources({ opencode: { popular: true } }).opencode.enabled).toBe(true)
    expect(parseRouteSources({ opencode: { popular: 5 } }).opencode).toEqual({
      enabled: true,
      plan: "zen",
      limit: 5,
    })
  })

  test("plan selects zen or go; anything else disables", () => {
    expect(parseRouteSources({ opencode: { plan: "go" } }).opencode).toEqual({
      enabled: true,
      plan: "go",
      limit: 10,
    })
    expect(parseRouteSources({ opencode: { plan: "zen" } }).opencode.plan).toBe("zen")
    expect(parseRouteSources({ opencode: { plan: "copilot" } }).opencode.enabled).toBe(false)
    expect(parseRouteSources({ opencode: { plan: 7 } }).opencode.enabled).toBe(false)
  })

  test("popular counts clamp (magnitudes never disable), garbage modes disable", () => {
    expect(parseRouteSources({ opencode: { popular: 0 } }).opencode.limit).toBe(1)
    expect(parseRouteSources({ opencode: { popular: -3 } }).opencode.limit).toBe(1)
    expect(parseRouteSources({ opencode: { popular: 999 } }).opencode.limit).toBe(40)
    expect(parseRouteSources({ opencode: { popular: 1.7 } }).opencode.limit).toBe(1)
    expect(parseRouteSources({ opencode: { popular: false } }).opencode.enabled).toBe(false)
    expect(parseRouteSources({ opencode: { popular: "all" } }).opencode.enabled).toBe(false)
    expect(parseRouteSources({ opencode: { popular: Number.NaN } }).opencode.enabled).toBe(false)
  })

  test("sources compose independently", () => {
    const cfg = parseRouteSources({ favorites: true, opencode: { plan: "go", popular: 3 } })
    expect(cfg.favorites).toBe(true)
    expect(cfg.opencode).toEqual({ enabled: true, plan: "go", limit: 3 })
  })
})

describe("rankSourcePopular", () => {
  const usageRows: Array<{ providerID?: unknown; modelID?: unknown; steps?: unknown }> = [
    { providerID: "opencode-go", modelID: "glm-5.3-flash", steps: 1 },
    { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", steps: 775 },
    { providerID: "delta", modelID: "zai-org/glm-5.3-flash", steps: 900_000 },
    { providerID: "opencode-go", modelID: "beam-free", steps: 3 },
    { providerID: "other", modelID: "irrelevant", steps: 9 },
    { providerID: "opencode-go", modelID: "", steps: 5 },
    { providerID: "opencode-go", modelID: null, steps: 5 },
    { providerID: "opencode-go", modelID: "unlisted", steps: 2 },
  ]

  test("filters to one provider, ranks by steps desc, truncates to limit", () => {
    const out = rankSourcePopular(usageRows, "opencode-go", 3)
    expect(out.map((c) => `${c.providerID}/${c.modelID}`)).toEqual([
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/beam-free",
      "opencode-go/unlisted",
    ])
  })

  test("non-numeric steps defensively count as 1", () => {
    const out = rankSourcePopular(
      [{ providerID: "p", modelID: "m", steps: "9" as any }],
      "p",
      10,
    )
    expect(out).toEqual([{ providerID: "p", modelID: "m" }])
  })

  test("ties break deterministically by modelID ascending", () => {
    const out = rankSourcePopular(
      [
        { providerID: "p", modelID: "zeta", steps: 4 },
        { providerID: "p", modelID: "alpha", steps: 4 },
        { providerID: "p", modelID: "mid", steps: 4 },
      ],
      "p",
      10,
    )
    expect(out.map((c) => c.modelID)).toEqual(["alpha", "mid", "zeta"])
  })

  test("limits of zero or less yield nothing; duplicates collapse", () => {
    expect(rankSourcePopular(usageRows, "opencode-go", 0)).toEqual([])
    const duplicated = [
      { providerID: "p", modelID: "m", steps: 3 },
      { providerID: "p", modelID: "m", steps: 9 },
    ]
    expect(rankSourcePopular(duplicated, "p", 10)).toEqual([{ providerID: "p", modelID: "m" }])
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
  const PSEUDO = "opencode-system-one"

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
