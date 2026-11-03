import { describe, expect, test } from "bun:test"
import { AUTO_PROVIDER, AUTO_MODEL, AUTO_REVIEW_MODEL, footerAutoLabel } from "../src/logic"

const auto = { providerID: AUTO_PROVIDER, modelID: AUTO_MODEL }
const review = { providerID: AUTO_PROVIDER, modelID: AUTO_REVIEW_MODEL }
const real = { providerID: "acme", modelID: "fast" }
// model-switched rows carry Model.Ref ({ id }), unlike ui.model.current()
const autoRef = { providerID: AUTO_PROVIDER, id: AUTO_MODEL }
const reviewRef = { providerID: AUTO_PROVIDER, id: AUTO_REVIEW_MODEL }
const realRef = { providerID: "acme", id: "fast" }

describe("footerAutoLabel", () => {
  test("no current model -> no marker", () => {
    expect(footerAutoLabel(undefined, undefined)).toBe("")
  })

  test("parked at an entry -> that entry's marker", () => {
    expect(footerAutoLabel(auto, undefined)).toBe("(auto)")
    expect(footerAutoLabel(review, undefined)).toBe("(auto-review)")
  })

  test("real model with no auto-grab switch -> no marker", () => {
    expect(footerAutoLabel(real, { model: realRef })).toBe("")
  })

  test("last switch went auto-entry -> real model -> marker", () => {
    expect(footerAutoLabel(real, { model: realRef, previous: autoRef })).toBe("(auto)")
    expect(footerAutoLabel(real, { model: realRef, previous: reviewRef })).toBe("(auto-review)")
  })

  test("last switch between two real models -> no marker", () => {
    expect(footerAutoLabel(real, { model: realRef, previous: realRef })).toBe("")
  })

  test("entries never borrow each other's marker", () => {
    expect(footerAutoLabel(review, { model: reviewRef, previous: autoRef })).toBe("(auto-review)")
    expect(footerAutoLabel(auto, { model: autoRef, previous: reviewRef })).toBe("(auto)")
  })

  test("a custom meta model gets its own id as the marker", () => {
    const triage = { providerID: AUTO_PROVIDER, modelID: "triage" }
    const triageRef = { providerID: AUTO_PROVIDER, id: "triage" }
    expect(footerAutoLabel(triage, undefined)).toBe("(triage)")
    expect(footerAutoLabel(real, { model: realRef, previous: triageRef })).toBe("(triage)")
  })
})
