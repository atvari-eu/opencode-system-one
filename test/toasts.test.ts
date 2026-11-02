// Event toast filtering: `toasts` sets, per event, the minimum severity that
// toasts. Missing keys default to `error`, so warnings stay quiet until
// configured; invalid values must fall back to that default rather than hide
// an error.

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TOAST_FILTER,
  TOAST_EVENTS,
  parseToastFilters,
  toastVisible,
} from "../src/logic"

describe("parseToastFilters", () => {
  test("absent or non-object keeps every event on the default floor", () => {
    expect(parseToastFilters(undefined)).toEqual({})
    expect(parseToastFilters(null)).toEqual({})
    expect(parseToastFilters("warning")).toEqual({})
    expect(parseToastFilters(["screen"])).toEqual({})
  })

  test("accepts a floor, true, or false per event", () => {
    expect(
      parseToastFilters({
        screen: "warning",
        error: "error",
        config: "info",
        scrub: true,
        approval: false,
      }),
    ).toEqual({
      screen: "warning",
      error: "error",
      config: "info",
      scrub: true,
      approval: false,
    })
  })

  test("ignores unknown events and invalid values", () => {
    expect(
      parseToastFilters({
        screen: "warn",
        error: "silent",
        config: 1,
        scrub: null,
        approval: "verbose",
        other: "error",
      }),
    ).toEqual({})
  })
})

describe("toastVisible", () => {
  test("defaults to error only", () => {
    expect(DEFAULT_TOAST_FILTER).toBe("error")
    for (const event of TOAST_EVENTS) {
      expect(toastVisible({}, event, "error")).toBe(true)
      expect(toastVisible({}, event, "warning")).toBe(false)
      expect(toastVisible({}, event, "info")).toBe(false)
      expect(toastVisible({}, event, "success")).toBe(false)
    }
  })

  test("a configured floor includes that severity and everything above it", () => {
    // `warning` means warning or higher - which includes error.
    expect(toastVisible({ screen: "warning" }, "screen", "warning")).toBe(true)
    expect(toastVisible({ screen: "warning" }, "screen", "error")).toBe(true)
    expect(toastVisible({ screen: "warning" }, "screen", "info")).toBe(false)
    expect(toastVisible({ screen: "info" }, "screen", "info")).toBe(true)
    expect(toastVisible({ screen: "info" }, "screen", "error")).toBe(true)
    // A floor applies only to its own event.
    expect(toastVisible({ screen: "info" }, "scrub", "warning")).toBe(false)
  })

  test("true shows every severity and false mutes the event", () => {
    expect(toastVisible({ scrub: true }, "scrub", "info")).toBe(true)
    expect(toastVisible({ scrub: true }, "scrub", "warning")).toBe(true)
    expect(toastVisible({ approval: false }, "approval", "error")).toBe(false)
    expect(toastVisible({ approval: false }, "approval", "warning")).toBe(false)
  })
})
