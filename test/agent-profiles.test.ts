// Agent profiles: the session's active OpenCode agent refines a routing turn
// by replacing the stance text, raising the Console pool's context floor, and
// banding the offered effort levels. Pure parsing and routing logic only.

import { describe, expect, test } from "bun:test"
import {
  clampEffortLevels,
  parseAgentProfiles,
  REVIEW_AGENT_CRITERIA,
  routeTurn,
  type Candidate,
  type RouteConfig,
  type RouteInput,
} from "../src/logic"

const byID = (profiles: ReturnType<typeof parseAgentProfiles>["profiles"], id: string) =>
  profiles.find((profile) => profile.id === id)

describe("parseAgentProfiles: built-in stances", () => {
  test("omitted agents yields build, plan, and explore", () => {
    const { profiles, warnings } = parseAgentProfiles(undefined)
    expect(warnings).toEqual([])
    expect(profiles.map((profile) => profile.id)).toEqual(["build", "plan", "explore"])
    expect(byID(profiles, "build")).toEqual({ id: "build" })
    expect(byID(profiles, "plan")).toMatchObject({
      minContext: 200_000,
      effort: { min: "medium" },
    })
    expect(byID(profiles, "plan")?.criteria).toContain("PLANNING turn")
    expect(byID(profiles, "explore")).toMatchObject({ effort: { min: "low", max: "medium" } })
    expect(byID(profiles, "explore")?.criteria).toContain("EXPLORATION turn")
  })

  test("agents: true is the built-in default; agents: false disables every profile", () => {
    expect(parseAgentProfiles(true).profiles).toHaveLength(3)
    expect(parseAgentProfiles(false).profiles).toEqual([])
  })
})

describe("parseAgentProfiles: overrides", () => {
  test("a user entry merges over the built-in stance, keeping untouched fields", () => {
    const { profiles, warnings } = parseAgentProfiles({
      plan: { criteria: "Custom plan stance", effort: { min: "high" } },
      reviewer: { criteria: "Inspect the diff for defects", effort: "high", minContext: 320_000 },
    })
    expect(warnings).toEqual([])
    expect(byID(profiles, "plan")).toMatchObject({
      criteria: "Custom plan stance",
      minContext: 200_000,
      effort: { min: "high" },
    })
    expect(byID(profiles, "reviewer")).toEqual({
      id: "reviewer",
      criteria: "Inspect the diff for defects",
      minContext: 320_000,
      effort: { min: "high" },
    })
  })

  test("false drops a single profile, leaving the others", () => {
    const { profiles } = parseAgentProfiles({ plan: false })
    expect(byID(profiles, "plan")).toBeUndefined()
    expect(byID(profiles, "build")).toBeDefined()
    expect(byID(profiles, "explore")).toBeDefined()
  })

  test("an empty criteria or effort clears the built-in field", () => {
    const { profiles } = parseAgentProfiles({ plan: { criteria: "  ", effort: false } })
    expect(byID(profiles, "plan")?.criteria).toBeUndefined()
    expect(byID(profiles, "plan")?.effort).toBeUndefined()
    expect(byID(profiles, "plan")?.minContext).toBe(200_000)
  })

  test("minContext wins only as a floor; zero is a valid override", () => {
    expect(byID(parseAgentProfiles({ plan: { minContext: 0 } }).profiles, "plan")?.minContext).toBe(0)
  })
})

describe("parseAgentProfiles: malformed input", () => {
  test("a non-object option warns and keeps the built-ins", () => {
    const { profiles, warnings } = parseAgentProfiles("nope")
    expect(profiles).toHaveLength(3)
    expect(warnings.some((warning) => warning.includes('"agents"'))).toBe(true)
  })

  test("a malformed profile value warns and keeps the built-in", () => {
    const { profiles, warnings } = parseAgentProfiles({ plan: 7 })
    expect(byID(profiles, "plan")?.minContext).toBe(200_000)
    expect(warnings.some((warning) => warning.includes('"agents.plan"'))).toBe(true)
  })

  test("bad fields warn and leave the current value", () => {
    const { profiles, warnings } = parseAgentProfiles({
      plan: { criteria: 7, minContext: -1, effort: "bogus" },
    })
    expect(byID(profiles, "plan")).toMatchObject({
      criteria: expect.stringContaining("PLANNING turn"),
      minContext: 200_000,
      effort: { min: "medium" },
    })
    expect(warnings).toHaveLength(3)
  })

  test("an inverted effort band keeps the floor and warns", () => {
    const { profiles, warnings } = parseAgentProfiles({ plan: { effort: { min: "high", max: "low" } } })
    expect(byID(profiles, "plan")?.effort).toEqual({ min: "high" })
    expect(warnings.some((warning) => warning.includes("below"))).toBe(true)
  })
})

describe("named stances", () => {
  test("@review resolves the canonical review text for a user-defined agent", () => {
    const { profiles, warnings } = parseAgentProfiles({
      review: { criteria: "@review", effort: { min: "medium" } },
    })
    expect(warnings).toEqual([])
    expect(byID(profiles, "review")).toMatchObject({
      criteria: REVIEW_AGENT_CRITERIA,
      effort: { min: "medium" },
    })
    expect(REVIEW_AGENT_CRITERIA).toContain("REVIEW turn")
  })

  test("@plan and @explore reuse the built-in stances case-insensitively", () => {
    const { profiles, warnings } = parseAgentProfiles({
      custom: { criteria: "@PLAN" },
      "my-explorer": { criteria: " @explore " },
    })
    expect(warnings).toEqual([])
    expect(byID(profiles, "custom")?.criteria).toBe(byID(profiles, "plan")?.criteria)
    expect(byID(profiles, "my-explorer")?.criteria).toBe(byID(profiles, "explore")?.criteria)
  })

  test("@default and @build clear an override back to the entry kind's text", () => {
    const { profiles, warnings } = parseAgentProfiles({
      plan: { criteria: "@default" },
      explore: { criteria: "@build", effort: { max: "low" } },
    })
    expect(warnings).toEqual([])
    expect(byID(profiles, "plan")?.criteria).toBeUndefined()
    expect(byID(profiles, "explore")?.criteria).toBeUndefined()
    expect(byID(profiles, "explore")?.effort).toEqual({ max: "low" })
  })

  test("an unknown @name warns and leaves the profile's criteria unchanged", () => {
    const { profiles, warnings } = parseAgentProfiles({ plan: { criteria: "@nope" } })
    expect(byID(profiles, "plan")?.criteria).toContain("PLANNING turn")
    expect(warnings.some((warning) => warning.includes("unknown stance"))).toBe(true)
    expect(byID(profiles, "nope")).toBeUndefined()
  })

  test("plain text that does not start with @ is the stance itself", () => {
    const { profiles, warnings } = parseAgentProfiles({ custom: { criteria: "email me @review later" } })
    expect(warnings).toEqual([])
    expect(byID(profiles, "custom")?.criteria).toBe("email me @review later")
  })
})

describe("clampEffortLevels", () => {
  const levels = ["none", "low", "medium", "high"]

  test("no band returns the listed levels unchanged", () => {
    expect(clampEffortLevels(levels, undefined)).toEqual(levels)
  })

  test("a floor and a ceiling keep only the levels inside the band", () => {
    expect(clampEffortLevels(levels, { min: "medium" })).toEqual(["medium", "high"])
    expect(clampEffortLevels(levels, { max: "low" })).toEqual(["none", "low"])
    expect(clampEffortLevels(levels, { min: "low", max: "medium" })).toEqual(["low", "medium"])
  })

  test("unknown levels (the no-variant 'default') pass through", () => {
    expect(clampEffortLevels(["default"], { min: "medium" })).toEqual(["default"])
  })

  test("when nothing fits, the nearest level survives", () => {
    expect(clampEffortLevels(["none", "max"], { min: "medium", max: "high" })).toEqual(["max"])
    expect(clampEffortLevels(["medium", "high"], { max: "low" })).toEqual(["medium"])
    expect(clampEffortLevels([], { min: "medium" })).toEqual([])
  })
})

const LEVELS: Record<string, string[]> = {
  "acme/base": ["none", "low", "medium", "high"],
  "acme/fast": ["none", "low", "medium", "high"],
  "zeta/flagship": ["medium", "high", "xhigh"],
}

const levelsFor = async (providerID: string, modelID: string): Promise<string[]> =>
  LEVELS[`${providerID}/${modelID}`] ?? []

const CANDIDATES: Candidate[] = [
  { providerID: "acme", modelID: "fast" },
  { providerID: "zeta", modelID: "flagship" },
]

const PAIR_CONFIG: RouteConfig = {
  effort: true,
  model: true,
  candidates: CANDIDATES,
  effortMinConfidence: 0.6,
  modelMinConfidence: 0.6,
}

const CURRENT = { providerID: "acme", modelID: "base", variant: "default" }

const turn = (config: RouteConfig, overrides: Partial<RouteInput> = {}): Promise<any> =>
  routeTurn(config, {
    prompt: "fix the flaky test",
    current: CURRENT,
    levelsFor,
    judge: async () => ({ answers: { route: { choice: "acme/base#medium", confidence: 0.9 } } }),
    ...overrides,
  })

describe("routeTurn: agent profiles", () => {
  test("a profile's criteria replaces the pair instructions and names the agent", async () => {
    let instructions = ""
    let state = ""
    let optionKeys: string[] = []
    await turn(PAIR_CONFIG, {
      profile: { id: "plan", criteria: "PLAN STANCE", effort: { min: "medium" } },
      judge: async (questions: any, judgedState: any) => {
        instructions = questions[0].instructions
        state = String(judgedState)
        optionKeys = Object.keys(questions[0].criteria)
        return { answers: { route: { choice: "acme/base#medium", confidence: 0.9 } } }
      },
    })
    expect(instructions).toBe("PLAN STANCE")
    expect(state).toContain('active agent is "plan"')
    expect(optionKeys.every((key) => /#(medium|high|xhigh)$/.test(key))).toBe(true)
  })

  test("model-only routing uses the profile criteria too", async () => {
    let instructions = ""
    await turn({ ...PAIR_CONFIG, effort: false }, {
      profile: { id: "reviewer", criteria: "REVIEW STANCE" },
      judge: async (questions: any) => {
        instructions = questions[0].instructions
        return { answers: { route: { choice: "acme/base", confidence: 0.9 } } }
      },
    })
    expect(instructions).toBe("REVIEW STANCE")
  })

  test("the entry kind text survives when the profile has no criteria", async () => {
    let instructions = ""
    await turn(PAIR_CONFIG, {
      review: true,
      profile: { id: "build" },
      judge: async (questions: any) => {
        instructions = questions[0].instructions
        return { answers: { route: { choice: "acme/base#medium", confidence: 0.9 } } }
      },
    })
    expect(instructions).toContain("REVIEW turn")
  })

  test("the built-in plan profile drives the turn end to end", async () => {
    const plan = parseAgentProfiles(undefined).profiles.find((profile) => profile.id === "plan")!
    let instructions = ""
    let optionKeys: string[] = []
    await turn(PAIR_CONFIG, {
      profile: plan,
      judge: async (questions: any) => {
        instructions = questions[0].instructions
        optionKeys = Object.keys(questions[0].criteria)
        return { answers: { route: { choice: "acme/fast#medium", confidence: 0.9 } } }
      },
    })
    expect(instructions).toContain("PLANNING turn")
    expect(optionKeys.some((key) => key.endsWith("#none") || key.endsWith("#low"))).toBe(false)
    expect(optionKeys.some((key) => key.endsWith("#medium"))).toBe(true)
  })

  test("the built-in explore band keeps low and medium and drops none/minimal", async () => {
    const explore = parseAgentProfiles(undefined).profiles.find((profile) => profile.id === "explore")!
    let offered: string[] = []
    const outcome = await turn(
      { ...PAIR_CONFIG, model: false },
      {
        profile: explore,
        judge: async (questions: any) => {
          offered = Object.keys(questions[0].criteria)
          return { answers: { effort: { choice: "medium", confidence: 0.9 } } }
        },
      },
    )
    expect(offered).toEqual(["low", "medium"])
    expect(outcome.switchTo?.variant).toBe("medium")
  })

  test("effort-only routing keeps only the levels inside the band", async () => {
    let offered: string[] = []
    const outcome = await turn(
      { ...PAIR_CONFIG, model: false },
      {
        profile: { id: "explore", effort: { max: "low" } },
        judge: async (questions: any) => {
          offered = Object.keys(questions[0].criteria)
          return { answers: { effort: { choice: "low", confidence: 0.9 } } }
        },
      },
    )
    expect(offered).toEqual(["none", "low"])
    expect(outcome.switchTo?.variant).toBe("low")
  })
})
