// The `routes` option is a record of routing meta models. These tests pin the
// pure parser: built-in defaults, legacy shapes, custom entries, and the drop
// rules that keep picker ids unique.

import { describe, expect, test } from "bun:test"
import { DEFAULT_POOL_SPLITS, parseRouteEntries } from "../src/logic"

const byKey = (entries: ReturnType<typeof parseRouteEntries>["entries"], key: string) =>
  entries.find((entry) => entry.key === key)!

describe("parseRouteEntries: built-in defaults", () => {
  test("omitted routes yields the enabled default and review entries", () => {
    const { entries, warnings } = parseRouteEntries(undefined)
    expect(warnings).toEqual([])
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review"])
    expect(entries.map((entry) => entry.modelID)).toEqual(["auto", "auto-review"])
    expect(entries.map((entry) => entry.title)).toEqual(["Auto", "Auto Review"])
    expect(entries.map((entry) => entry.review)).toEqual([false, true])
    expect(entries.every((entry) => entry.enable && entry.usePool)).toBe(true)
  })

  test("routes: true behaves like an omitted option", () => {
    expect(parseRouteEntries(true).entries.map((entry) => entry.key)).toEqual(["default", "review"])
  })

  test("routes: false keeps both entries parsed but disabled", () => {
    const { entries } = parseRouteEntries(false)
    expect(entries.map((entry) => entry.key)).toEqual(["default", "review"])
    expect(entries.every((entry) => !entry.enable)).toBe(true)
  })
})

describe("parseRouteEntries: legacy shapes", () => {
  test("a flat legacy object becomes the default entry and keeps review on", () => {
    const { entries, warnings } = parseRouteEntries({
      candidates: ["acme/cheap"],
      fallback: "acme/cheap",
    })
    expect(byKey(entries, "default").candidates).toEqual([{ providerID: "acme", modelID: "cheap" }])
    expect(byKey(entries, "default").fallback).toEqual({ providerID: "acme", modelID: "cheap" })
    expect(byKey(entries, "review").enable).toBe(true)
    expect(warnings.some((warning) => warning.includes("flat"))).toBe(true)
  })

  test("a flat enable:false disables only the default entry", () => {
    const { entries } = parseRouteEntries({ enable: false })
    expect(byKey(entries, "default").enable).toBe(false)
    expect(byKey(entries, "review").enable).toBe(true)
  })

  test("the legacy auto key is accepted with a notice and loses to routes", () => {
    const alias = parseRouteEntries(undefined, { auto: { default: { candidates: ["acme/alias"] } } })
    expect(byKey(alias.entries, "default").candidates).toEqual([{ providerID: "acme", modelID: "alias" }])
    expect(alias.warnings.some((warning) => warning.includes('"auto" is deprecated'))).toBe(true)

    const both = parseRouteEntries(
      { default: { candidates: ["acme/next"] } },
      { auto: { default: { candidates: ["acme/alias"] } } },
    )
    expect(byKey(both.entries, "default").candidates).toEqual([{ providerID: "acme", modelID: "next" }])
    expect(both.warnings.some((warning) => warning.includes('"auto" is ignored'))).toBe(true)
  })
})

describe("parseRouteEntries: custom meta models", () => {
  test("a custom key registers its own id, name, and order after the built-ins", () => {
    const { entries } = parseRouteEntries({
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
      usePool: false,
    })
  })

  test("a custom entry defaults its name to the key and can opt into review", () => {
    const { entries } = parseRouteEntries({ deep: { kind: "review" } })
    expect(byKey(entries, "deep")).toMatchObject({ title: "deep", kind: "review", review: true })
  })

  test("an entry value of false stays parsed but disabled", () => {
    const { entries } = parseRouteEntries({ default: false, triage: false })
    expect(byKey(entries, "default").enable).toBe(false)
    expect(byKey(entries, "triage").enable).toBe(false)
  })

  test("invalid, reserved, and duplicate keys are dropped with warnings", () => {
    const { entries, warnings } = parseRouteEntries({
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

  test("aliases render into the title, minConfidence clamps, favorites disable the pool", () => {
    const { entries } = parseRouteEntries({
      triage: {
        aliases: ["t", "  "],
        minConfidence: 5,
        favorites: true,
      },
    })
    const triage = byKey(entries, "triage")
    expect(triage.title).toBe("triage (t)")
    expect(triage.minConfidence).toBe(0.99)
    expect(triage.usePool).toBe(false)
    expect(triage.sources.favorites).toBe(true)
  })
})

describe("parseRouteEntries: the pool as a source", () => {
  test("implicit on a bare entry, off with candidates or a source", () => {
    expect(byKey(parseRouteEntries({}).entries, "default").usePool).toBe(true)
    expect(
      byKey(parseRouteEntries({ default: { candidates: ["acme/cheap"] } }).entries, "default").usePool,
    ).toBe(false)
    expect(
      byKey(parseRouteEntries({ default: { favorites: true } }).entries, "default").usePool,
    ).toBe(false)
  })

  test("pool: true merges the pool into configured candidates", () => {
    const entry = byKey(
      parseRouteEntries({
        default: { candidates: ["acme/cheap"], pool: true },
      }).entries,
      "default",
    )
    expect(entry.usePool).toBe(true)
    expect(entry.candidates).toEqual([{ providerID: "acme", modelID: "cheap" }])
  })

  test("pool: false opts a bare entry out", () => {
    const entry = byKey(parseRouteEntries({ default: { pool: false } }).entries, "default")
    expect(entry.usePool).toBe(false)
  })

  test("an inlined pool shape is an explicit opt-in and keeps candidates", () => {
    const entry = byKey(
      parseRouteEntries({
        default: { candidates: ["acme/cheap"], pool: { strong: 3 } },
      }).entries,
      "default",
    )
    expect(entry.usePool).toBe(true)
    expect(entry.sources.pool).toBe("own")
    expect(entry.poolConfig).toEqual({ ...DEFAULT_POOL_SPLITS.default, strong: 3 })
    expect(entry.candidates).toEqual([{ providerID: "acme", modelID: "cheap" }])
  })

  test("the kind selects the pool when no shape is given", () => {
    expect(byKey(parseRouteEntries({}).entries, "default").poolConfig).toEqual(
      DEFAULT_POOL_SPLITS.default,
    )
    expect(byKey(parseRouteEntries({}).entries, "review").poolConfig).toEqual(
      DEFAULT_POOL_SPLITS.review,
    )
    expect(
      byKey(parseRouteEntries({ triage: { kind: "review" } }).entries, "triage").poolConfig,
    ).toEqual(DEFAULT_POOL_SPLITS.review)
    expect(
      byKey(parseRouteEntries({ default: { pool: false } }).entries, "default")
        .poolConfig,
    ).toBeNull()
  })

  test("malformed pool falls back to the implicit rule", () => {
    const entry = byKey(parseRouteEntries({ default: { pool: 7 } }).entries, "default")
    expect(entry.usePool).toBe(true)
    expect(entry.sources.pool).toBe("auto")
    expect(entry.poolConfig).toEqual(DEFAULT_POOL_SPLITS.default)
  })

  test("the removed named-pool string fails closed and warns", () => {
    const parsed = parseRouteEntries({ default: { pool: "big" } })
    const entry = byKey(parsed.entries, "default")
    expect(entry.usePool).toBe(false)
    expect(entry.poolConfig).toBeNull()
    expect(parsed.warnings.some((warning) => warning.includes("no longer names a pool"))).toBe(true)
  })
})

describe("parseRouteEntries: removed sources object", () => {
  test("a leftover sources object warns and contributes nothing", () => {
    const parsed = parseRouteEntries({ default: { sources: { favorites: true } } })
    const entry = byKey(parsed.entries, "default")
    expect(entry.sources.favorites).toBe(false)
    expect(entry.usePool).toBe(true)
    expect(
      parsed.warnings.some((warning) => warning.includes('"routes.default.sources" was removed')),
    ).toBe(true)
  })

  test("a pool setting under sources is ignored, not honored", () => {
    const parsed = parseRouteEntries({ default: { sources: { pool: false } } })
    const entry = byKey(parsed.entries, "default")
    expect(entry.sources.pool).toBe("auto")
    expect(entry.usePool).toBe(true)
    expect(
      parsed.warnings.some((warning) => warning.includes('"routes.default.sources" was removed')),
    ).toBe(true)
  })
})
