import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../src/audit"
import type { JevStatusInfo } from "../src/rpc"
import { effectiveModel, eventStats, statusSections, statusText } from "../src/status"

function audit(partial: Partial<AuditEntry> & { id: string; tone: AuditEntry["tone"] }): AuditEntry {
  return {
    at: 1_700_000_000_000,
    kind: "screen",
    summary: "summary",
    ...partial,
  }
}

const STATUS: JevStatusInfo = {
  provider: "opencode",
  endpoint: "https://opencode.ai/inference/systemone/v1/systemone",
  model: "jev-1.13-free",
  pick: "jev-1.13",
  catalog: "live",
  health: { ok: false, fault: "401 unauthorized", events: true },
  models: [
    { id: "jev-1.13-free" },
    { id: "jev-1.13" },
    { id: "jev-broken", fault: "404 unknown model" },
  ],
  features: [
    { name: "screen", state: "on · annotate/notice · webfetch,websearch" },
    { name: "approvals", state: "off" },
  ],
  pools: [
    {
      id: "auto",
      review: false,
      enabled: true,
      shape: "1 cheap + 1 popular + 1 strong of the top 18",
      explicit: [],
      sourced: ["opencode/fast"],
      excluded: [],
      usable: ["opencode/fast", "opencode/cheap"],
      fallback: "opencode/cheap",
    },
    {
      id: "auto-review",
      review: true,
      enabled: true,
      explicit: ["opencode/strong"],
      sourced: [],
      excluded: ["opencode/fast"],
      usable: ["opencode/strong"],
    },
  ],
}

describe("eventStats", () => {
  test("counts severities and kinds, keeping the newest error", () => {
    const stats = eventStats([
      audit({ id: "1", tone: "ok", kind: "screen" }),
      audit({ id: "2", tone: "warn", kind: "scrub", summary: "scrubbed" }),
      audit({ id: "3", tone: "error", kind: "error", summary: "old" }),
      audit({ id: "4", tone: "error", kind: "error", summary: "new" }),
      audit({ id: "5", tone: "info", kind: "approval" }),
    ])
    expect(stats.total).toBe(5)
    expect(stats.ok).toBe(1)
    expect(stats.warn).toBe(1)
    expect(stats.error).toBe(2)
    expect(stats.info).toBe(1)
    expect(stats.kinds).toEqual([
      { kind: "screen", count: 1 },
      { kind: "error", count: 2 },
      { kind: "scrub", count: 1 },
      { kind: "approval", count: 1 },
    ])
    expect(stats.lastError?.summary).toBe("new")
  })

  test("an empty ring reports zeroes, not a crash", () => {
    expect(eventStats([])).toEqual({ total: 0, ok: 0, warn: 0, error: 0, info: 0, kinds: [] })
  })
})

describe("effectiveModel", () => {
  test("a session pin wins over the chain model", () => {
    expect(effectiveModel(STATUS)).toBe("jev-1.13")
    expect(effectiveModel({ ...STATUS, pick: undefined })).toBe("jev-1.13-free")
  })
})

describe("statusSections", () => {
  test("lays out every requested area in order", () => {
    const sections = statusSections(STATUS, [], 1_700_000_000_000)
    expect(sections.map((section) => section.title)).toEqual([
      "decision model",
      "available decision models (3)",
      "model pools",
      "health",
      "features",
      "recent events",
    ])
  })

  test("marks the current candidate and shows deployment fault and pools", () => {
    const text = statusText(STATUS, [
      audit({ id: "e", tone: "error", kind: "error", summary: "judge failed" }),
    ])
    expect(text).toContain("current: jev-1.13 (pinned for this session)")
    expect(text).toContain("chain: jev-1.13-free")
    expect(text).toContain("› jev-1.13  (current)")
    expect(text).toContain("✗ 404 unknown model")
    expect(text).toContain("auto: 2 usable")
    expect(text).toContain("pool: 1 cheap + 1 popular + 1 strong of the top 18")
    expect(text).toContain("usable: opencode/fast, opencode/cheap")
    expect(text).toContain("excluded (shared with the default pool): opencode/fast")
    expect(text).toContain("deployment: FAULT - 401 unauthorized")
    expect(text).toContain("event channel: on (jev-config rpc)")
    expect(text).toContain("screen: on · annotate/notice")
    expect(text).toContain("severity: ok 0 · warn 0 · error 1 · info 0 (1 events)")
    expect(text).toContain("last error:")
  })

  test("an unregistered entry and an empty pool are explicit", () => {
    const sections = statusSections(
      {
        ...STATUS,
        pools: [
          { id: "auto", review: false, enabled: false, explicit: [], sourced: [], excluded: [], usable: [] },
          { id: "auto-review", review: true, enabled: true, explicit: [], sourced: [], excluded: [], usable: [] },
        ],
      },
      [],
    )
    const pool = sections.find((section) => section.title === "model pools")!
    expect(pool.lines.map((line) => line.text)).toContain("auto: off (entry not registered)")
    expect(pool.lines.map((line) => line.text)).toContain(
      "  no usable candidates - routing stays off for this entry",
    )
  })
})
