// Decision-model discovery tests: parsing the models.dev catalog slice at
// type=decision, endpoint composition from the model-level provider.api, the
// picker-candidate fallback chain, and the expired-API-key 401 class.
// Pure logic, no plugin host, no network - the fixtures pin the live shape
// recorded while probing models.dev (opencode provider record, real fields).

import { describe, expect, test } from "bun:test"
import {
  CONSOLE_SYSTEMONE,
  DECISION_CATALOG_URL,
  PICKER_DEFAULT_MODELS,
  jevUserError,
  normalizePickerModels,
  parseDecisionIndex,
  surfaceTitle,
  systemoneRoute,
} from "../src/logic"

// Live-shape fixture: provider record keys are [id, env, npm, api, name, doc,
// models]; the provider-level `api` is the CHAT base (must never be picked
// as the System One endpoint), the System One base nests per model record at
// provider.api. Slice keys: providers at the root, model records marked
// type:"decision".
const CATALOG_FIXTURE = {
  models: { "typesafe/jev-latest": { id: "typesafe/jev-latest", type: "decision" } },
  providers: {
    opencode: {
      id: "opencode",
      env: ["OPENCODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/inference/openai/v1",
      name: "OpenCode",
      models: {
        "jev-1.13": {
          id: "jev-1.13",
          type: "decision",
          structured_output: true,
          cost: { input: 0.042, output: 0 },
          canonical_model_id: "typesafe/jev-latest",
          provider: { npm: "@ai-sdk/typesafe-ai", api: "https://opencode.ai/inference/systemone/v1" },
        },
        "jev-1.13-free": {
          id: "jev-1.13-free",
          type: "decision",
          cost: { input: 0, output: 0 },
          provider: { npm: "@ai-sdk/typesafe-ai", api: "https://opencode.ai/inference/systemone/v1" },
        },
        "impostor-1.13": {
          id: "impostor-1.13",
          type: "chat",
          provider: { api: "https://chat.example/v1" },
        },
      },
    },
    greenpt: {
      id: "greenpt",
      models: { metis: { type: "decision", provider: { api: "https://greenpt.example/v1" } } },
    },
    "no-api": {
      id: "no-api",
      models: { bare: { type: "decision" } },
    },
    "no-models": { id: "no-models" },
    broken: null,
    mixed: {
      providers: { ignored: true },
    },
  },
}

const SNAPSHOT_FIXTURE = {
  at: "2026-10-22T00:00:00.000Z",
  providers: CATALOG_FIXTURE.providers,
}

describe("parseDecisionIndex", () => {
  const index = parseDecisionIndex(CATALOG_FIXTURE)

  test("decision models only, record order preserved, markers enforced", () => {
    expect(index.opencode?.models).toEqual(["jev-1.13", "jev-1.13-free"])
  })

  test("the chat base is never picked - only each model record's nested provider.api", () => {
    // The chat record ("api": .../openai/v1 at the provider level, and the
    // type:chat impostor model) must not leak into the System One base.
    expect(index.opencode?.api).toBe("https://opencode.ai/inference/systemone/v1")
    expect(index.opencode?.api).not.toContain("/openai/")
  })

  test("first decision model names the base; base-less entries stay api-less", () => {
    expect(index.greenpt?.api).toBe("https://greenpt.example/v1")
    expect(index["no-api"]?.models).toEqual(["bare"])
    expect(index["no-api"]?.api).toBeUndefined()
  })

  test("entries without decision models or malformed records drop out", () => {
    expect(index["no-models"]).toBeUndefined()
    expect(index.broken).toBeUndefined()
    expect(index.mixed).toBeUndefined()
    expect(Object.keys(index).sort()).toEqual(["greenpt", "no-api", "opencode"])
  })

  test("provider-keyed roots and snapshot wrappers parse the same", () => {
    const flat = parseDecisionIndex(CATALOG_FIXTURE.providers)
    const snap = parseDecisionIndex(SNAPSHOT_FIXTURE)
    expect(snap).toEqual(flat)
  })

  test("unknown shapes yield an empty index - never a guess", () => {
    for (const junk of [undefined, null, 42, "catalog", [], { providers: [] }]) {
      expect(parseDecisionIndex(junk)).toEqual({})
    }
  })
})

describe("endpoint composition from the catalog", () => {
  test("the opencode record composes exactly the formerly baked Console route", () => {
    const index = parseDecisionIndex(CATALOG_FIXTURE)
    expect(systemoneRoute(index.opencode!.api!)).toBe(CONSOLE_SYSTEMONE)
  })

  test("a base already ending in the route stays as given", () => {
    const index = parseDecisionIndex({
      providers: {
        routed: {
          models: { "m-1": { type: "decision", provider: { api: CONSOLE_SYSTEMONE } } },
        },
      },
    })
    expect(systemoneRoute(index.routed!.api!)).toBe(CONSOLE_SYSTEMONE)
  })

  test("the discovery URL is the server-filtered decision slice, not type=all", () => {
    expect(DECISION_CATALOG_URL).toBe("https://models.dev/catalog.json?type=decision")
  })
})

describe("picker fallback chain", () => {
  const discovered = ["jev-1.13", "jev-1.13-free"]

  test("catalog candidates apply when no models option is set", () => {
    expect(normalizePickerModels(undefined, discovered)).toEqual(discovered)
    expect(normalizePickerModels([], discovered)).toEqual(discovered)
  })

  test("the models option replaces the discovery list outright", () => {
    expect(normalizePickerModels([" custom-model "], discovered)).toEqual(["custom-model"])
  })

  test("a broken option falls to the discovery list, then the offline default", () => {
    expect(normalizePickerModels([42, null, {}], discovered)).toEqual(discovered)
    expect(normalizePickerModels([42], undefined)).toEqual([...PICKER_DEFAULT_MODELS])
    expect(normalizePickerModels(undefined, undefined)).toEqual([...PICKER_DEFAULT_MODELS])
  })

  test("falls back are copied, never aliased", () => {
    const list = normalizePickerModels(undefined, discovered)
    list.push("x")
    expect(discovered).not.toContain("x")
  })
})

describe("expired Console API key 401 class", () => {
  const LIVE_EXPIRED =
    "This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key."

  test("the endpoint's field-reported diagnostic gets the replace-the-key remedy", () => {
    expect(jevUserError(`jev: 401 - ${LIVE_EXPIRED}`)?.title).toBe(
      "jev: the Console API key expired (401) - create a new one in the OpenCode Console and replace it in your store (`opencode auth login` will not renew API keys)",
    )
  })

  test("the will-not-renew wording alone classes the same way", () => {
    expect(jevUserError("jev: 401 - Signing in again will not renew this key")?.title).toContain(
      "create a new one in the OpenCode Console",
    )
  })

  test("surfaced titles polish through the screen-failure wrap too", () => {
    expect(
      surfaceTitle(`screen unavailable for webfetch: jev: 401 - ${LIVE_EXPIRED}`),
    ).toContain("create a new one in the OpenCode Console")
  })

  test("the plain 401 (session) keeps its existing retry title", () => {
    expect(jevUserError("jev: 401 - credential rejected")?.title).toBe(
      "jev: credential rejected (401) - expired session? run `opencode auth login` again",
    )
  })
})
