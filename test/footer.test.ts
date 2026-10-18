import { describe, expect, test } from "bun:test"
import { AUTO_PROVIDER, footerAutoMarker } from "../src/logic"

const auto = { providerID: AUTO_PROVIDER, modelID: "auto" }
const real = { providerID: "acme", modelID: "fast" }

describe("footerAutoMarker", () => {
  test("no current model -> no marker", () => {
    expect(footerAutoMarker(undefined, undefined)).toBe(false)
  })

  test("parked at the auto entry -> marker", () => {
    expect(footerAutoMarker(auto, undefined)).toBe(true)
  })

  test("real model with no auto-grab switch -> no marker", () => {
    expect(footerAutoMarker(real, { model: real })).toBe(false)
  })

  test("last switch went auto-entry -> real model -> marker", () => {
    expect(footerAutoMarker(real, { model: real, previous: auto })).toBe(true)
  })

  test("last switch between two real models -> no marker", () => {
    expect(footerAutoMarker(real, { model: real, previous: real })).toBe(false)
  })
})
