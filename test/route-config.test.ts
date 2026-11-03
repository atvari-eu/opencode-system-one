// The `auto` option is a record of routing meta models. These tests pin the
// pure parser: built-in defaults, legacy shapes, custom entries, and the drop
// rules that keep picker ids unique.

import { describe, expect, test } from "bun:test"
import { parseAutoEntries } from "../src/logic"

const byKey = (entries: ReturnType<typeof parseAutoEntries>["entries"], key: string) =>
  entries.find((entry) => entry.key === key)!

describe("parseAutoEntries: built-in defaults", () => {
  test("omitted auto yields the enabled default and review entries", () => {
    const { entries, warnings } = parseAutoEntries(undefined)
    expect(warnings).toEqual([])
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review"])
    expect(entries.map((entry) => entry.modelID)).toEqual(["auto", "auto-review"])
    expect(entries.map((entry) => entry.title)).toEqual(["Auto", "Auto Review"])
    expect(entries.map((entry) => entry.review)).toEqual([false, true])
    expect(entries.every((entry) => entry.enable && entry.defaultPool)).toBe(true)
  })

  test("auto: true behaves like an omitted option", () => {
    expect(parseAutoEntries(true).entries.map((entry) => entry.key)).toEqual(["default", "review"])
  })

  test("auto: false keeps both entries parsed but disabled", () => {
    const { entries } = parseAutoEntries(false)
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review"])
    expect(entries.every((entry) => !entry.enable)).toBe(true)
  })
})

describe("parseAutoEntries: legacy shapes", () => {
  test("a flat legacy object becomes the default entry and keeps review on", () => {
    const { entries, warnings } = parseAutoEntries({
      candidates: ["acme/cheap"],
      fallback: "acme/cheap",
    })
    expect(byKey(entries, "default").candidates).toEqual([{ providerID: "acme", modelID: "cheap" }])
    expect(byKey(entries, "default").fallback).toEqual({ providerID: "acme", modelID: "cheap" })
    expect(byKey(entries, "review").enable).toBe(true)
    expect(warnings.some((warning) => warning.includes("flat"))).toBe(true)
  })

  test("a flat enable:false disables only the default entry", () => {
    const { entries } = parseAutoEntries({ enable: false })
    expect(byKey(entries, "default").enable).toBe(false)
    expect(byKey(entries, "review").enable).toBe(true)
  })

  test("autoReview maps onto auto.review, including false", () => {
    const mapped = parseAutoEntries(undefined, { candidates: ["review/deep"] })
    expect(byKey(mapped.entries, "review").candidates).toEqual([
      { providerID: "review", modelID: "deep" },
    ])
    expect(mapped.warnings.some((warning) => warning.includes("autoReview"))).toBe(true)

    expect(byKey(parseAutoEntries(undefined, false).entries, "review").enable).toBe(false)
    expect(byKey(parseAutoEntries(undefined, null).entries, "review").enable).toBe(false)
    expect(byKey(parseAutoEntries(undefined, true).entries, "review").enable).toBe(true)
  })

  test("auto.review wins over the deprecated autoReview key", () => {
    const { entries, warnings } = parseAutoEntries(
      { default: { candidates: ["acme/cheap"] }, review: { enable: false } },
      { candidates: ["review/deep"] },
    )
    expect(byKey(entries, "review").enable).toBe(false)
    expect(byKey(entries, "review").candidates).toEqual([])
    expect(warnings.some((warning) => warning.includes("ignored"))).toBe(true)
  })
})

describe("parseAutoEntries: custom meta models", () => {
  test("a custom key registers its own id, name, and order after the built-ins", () => {
    const { entries } = parseAutoEntries({
      default: { candidates: ["acme/cheap"] },
      review: { enable: false },
      triage: { candidates: ["acme/triage"], name: "Triage" },
    })
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review", "triage"])
    expect(byKey(entries, "triage")).toMatchObject({
      providerID: "opencode-decisions",
      modelID: "triage",
      title: "Triage",
      kind: "default",
      review: false,
      enable: true,
      defaultPool: false,
    })
  })

  test("a custom entry defaults its name to the key and can opt into review", () => {
    const { entries } = parseAutoEntries({ deep: { kind: "review" } })
    expect(byKey(entries, "deep")).toMatchObject({ title: "deep", kind: "review", review: true })
  })

  test("an entry value of false stays parsed but disabled", () => {
    const { entries } = parseAutoEntries({ default: false, triage: false })
    expect(byKey(entries, "default").enable).toBe(false)
    expect(byKey(entries, "triage").enable).toBe(false)
  })

  test("invalid, reserved, and duplicate keys are dropped with warnings", () => {
    const { entries, warnings } = parseAutoEntries({
      default: { candidates: ["acme/cheap"] },
      "Bad Key": {},
      candidates: {},
      auto: {},
    })
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review"])
    expect(warnings.some((warning) => warning.includes('"Bad Key"'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('"candidates"'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('"auto"'))).toBe(true)
  })

  test("aliases render into the title, minConfidence clamps, sources disable the default pool", () => {
    const { entries } = parseAutoEntries({
      triage: {
        aliases: ["t", "  "],
        minConfidence: 5,
        sources: { favorites: true },
      },
    })
    const triage = byKey(entries, "triage")
    expect(triage.title).toBe("triage (t)")
    expect(triage.minConfidence).toBe(0.99)
    expect(triage.defaultPool).toBe(false)
    expect(triage.sources.favorites).toBe(true)
  })
})
