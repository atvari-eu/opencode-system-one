import { describe, expect, test } from "bun:test"
import {
  PICKER_DEFAULT_MODELS,
  describeModelRows,
  effectiveJevModel,
  jevModelTag,
  normalizePickerModels,
  seedJevBaseLabel,
  settleUnverifiedJevSession,
} from "../src/logic"

describe("normalizePickerModels", () => {
  test("absent/invalid option keeps the known defaults", () => {
    expect(normalizePickerModels(undefined)).toEqual(PICKER_DEFAULT_MODELS)
    expect(normalizePickerModels("jev-1.13")).toEqual(PICKER_DEFAULT_MODELS)
    expect(normalizePickerModels([])).toEqual(PICKER_DEFAULT_MODELS)
    expect(normalizePickerModels([42, null, {}])).toEqual(PICKER_DEFAULT_MODELS)
    expect(normalizePickerModels(["  ", ""])).toEqual(PICKER_DEFAULT_MODELS)
  })

  test("strings are trimmed, deduped in order, empties dropped", () => {
    expect(normalizePickerModels(["jev-1.13", " jev-1.13-free ", "jev-1.13", ""])).toEqual([
      "jev-1.13",
      "jev-1.13-free",
    ])
    expect(normalizePickerModels([" custom-model "])).toEqual(["custom-model"])
  })

  test("defaults copy is independent of the module constant", () => {
    const list = normalizePickerModels(undefined)
    list.push("x")
    expect(PICKER_DEFAULT_MODELS).not.toContain("x")
  })
})

describe("effectiveJevModel", () => {
  test("a pin wins over the chain", () => {
    expect(effectiveJevModel("jev-1.13", "jev-1.13-free")).toBe("jev-1.13")
  })

  test("whitespace-only/empty/absent pins resolve to the chain", () => {
    expect(effectiveJevModel("   ", "chain")).toBe("chain")
    expect(effectiveJevModel("", "chain")).toBe("chain")
    expect(effectiveJevModel(undefined, "chain")).toBe("chain")
    expect(effectiveJevModel(42, "chain")).toBe("chain")
  })

  test("pinned value is trimmed", () => {
    expect(effectiveJevModel(" jev-1.13 ", "chain")).toBe("jev-1.13")
  })
})

describe("jevModelTag", () => {
  test("strips the redundant jev- prefix", () => {
    expect(jevModelTag("jev-1.13-free")).toBe("(jev:1.13-free)")
    expect(jevModelTag("jev-1.13")).toBe("(jev:1.13)")
  })

  test("custom ids stay verbatim", () => {
    expect(jevModelTag("prod-jev-model")).toBe("(jev:prod-jev-model)")
  })

  test("empty/absent ids render nothing", () => {
    expect(jevModelTag(undefined)).toBe("")
    expect(jevModelTag("")).toBe("")
    expect(jevModelTag("   ")).toBe("")
    expect(jevModelTag(42)).toBe("")
  })

  test("degenerate 'jev-' id keeps itself visible", () => {
    expect(jevModelTag("jev-")).toBe("(jev:jev-)")
  })
})

describe("describeModelRows", () => {
  test("rows without faults carry only the id", () => {
    expect(describeModelRows(["a", "b"])).toEqual([{ id: "a" }, { id: "b" }])
  })

  test("faultOf results are attached; empty faults skip the key", () => {
    const rows = describeModelRows(["a", "b", "c"], (id) => (id === "b" ? "unreachable" : undefined))
    expect(rows).toEqual([{ id: "a" }, { id: "b", fault: "unreachable" }, { id: "c" }])
    expect("fault" in describeModelRows(["b"], () => "")[0]!).toBe(false)
  })
})

describe("seedJevBaseLabel", () => {
  test("a missing base takes the plugin option model", () => {
    const draft = { sessions: {} }
    seedJevBaseLabel(draft, "jev-1.13")
    expect(draft.base).toBe("jev-1.13")
  })

  test("unknown or blank options leave the draft alone; whitespace trims", () => {
    const draft: { base?: string; sessions: Record<string, string> } = { sessions: {} }
    seedJevBaseLabel(draft, undefined)
    seedJevBaseLabel(draft, 42)
    seedJevBaseLabel(draft, "   ")
    expect(draft.base).toBeUndefined()
    draft.base = undefined
    seedJevBaseLabel(draft, "  jev-1.13-free  ")
    expect(draft.base).toBe("jev-1.13-free")
  })

  test("a base describe already filled in is never overwritten", () => {
    const draft = { base: "jev-1.13-free", sessions: {} }
    seedJevBaseLabel(draft, "jev-1.13")
    expect(draft.base).toBe("jev-1.13-free")
  })
})

describe("settleUnverifiedJevSession", () => {
  test("an unknown session settles to the empty checked entry", () => {
    const draft: { base?: string; sessions?: Record<string, string> } = { base: "jev-1.13" }
    settleUnverifiedJevSession(draft, "s1")
    expect(draft.sessions).toEqual({ s1: "" })
    expect(draft.base).toBe("jev-1.13")
  })

  test("missing sessions map and existing entries (a settled pin) are kept", () => {
    const draft: { sessions?: Record<string, string> } = {}
    settleUnverifiedJevSession(draft, "s1")
    expect(draft.sessions).toEqual({ s1: "" })
    const pinned = { sessions: { s1: "jev-1.13-free" } }
    settleUnverifiedJevSession(pinned, "s1")
    expect(pinned.sessions).toEqual({ s1: "jev-1.13-free" })
  })
})
