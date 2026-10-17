// Screen gate tests: tool-name filtering, self-skip, and the redact scope rule.

import { describe, expect, test } from "bun:test"
import {
  parseScreenTools,
  screenApplies,
  screenRedacts,
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
