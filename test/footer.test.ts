import { describe, expect, test } from "bun:test"
import { AUTO_PROVIDER, footerAutoMarker } from "../src/logic"

const auto = { providerID: AUTO_PROVIDER, modelID: "auto" }
const real = { providerID: "acme", modelID: "fast" }
// model-switched rows carry Model.Ref ({ id }), unlike ui.model.current()
const autoRef = { providerID: AUTO_PROVIDER, id: "auto" }
const realRef = { providerID: "acme", id: "fast" }

describe("footerAutoMarker", () => {
  test("no current model -> no marker", () => {
    expect(footerAutoMarker(undefined, undefined)).toBe(false)
  })

  test("parked at the auto entry -> marker", () => {
    expect(footerAutoMarker(auto, undefined)).toBe(true)
  })

  test("real model with no auto-grab switch -> no marker", () => {
    expect(footerAutoMarker(real, { model: realRef })).toBe(false)
  })

  test("last switch went auto-entry -> real model -> marker", () => {
    expect(footerAutoMarker(real, { model: realRef, previous: autoRef })).toBe(true)
  })

  test("last switch between two real models -> no marker", () => {
    expect(footerAutoMarker(real, { model: realRef, previous: realRef })).toBe(false)
  })
})
