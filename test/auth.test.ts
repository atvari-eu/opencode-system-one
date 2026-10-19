// Auth plumbing tests: auth-export parsing and status-aware error text.
// Pure logic, no plugin host, no live jev, no subprocess.

import { describe, expect, test } from "bun:test"
import { credentialRejected, jevAuthError, normaliseProvider, parseAuthExport } from "../src/logic"

const MUNITO_ENTRY = {
  id: "cred_m",
  integrationID: "munito",
  label: "Munito",
  active: true,
  value: { type: "key", key: "munitoai_x" },
}

describe("parseAuthExport", () => {
  test("defaults to the console (opencode) integration", () => {
    expect(
      parseAuthExport([
        {
          id: "cred_k",
          integrationID: "opencode",
          label: "atvari",
          active: true,
          value: { type: "key", key: "sk_x" },
        },
        {
          id: "cred_g",
          integrationID: "opencode-go",
          label: "OpenCode Go",
          active: true,
          value: { type: "key", key: "go_x" },
        },
      ]),
    ).toBe("sk_x")
  })

  test("an explicit integration selects its own entry", () => {
    const export_ = [
      {
        id: "cred_k",
        integrationID: "opencode",
        label: "atvari",
        active: true,
        value: { type: "key", key: "sk_x" },
      },
      {
        id: "cred_g",
        integrationID: "opencode-go",
        label: "OpenCode Go",
        active: true,
        value: { type: "key", key: "go_x" },
      },
    ]
    expect(parseAuthExport(export_, "opencode-go")).toBe("go_x")
    expect(parseAuthExport(export_, "opencode")).toBe("sk_x")
    expect(parseAuthExport(export_, "munitoai")).toBeUndefined()
  })

  test("the active Console OAuth session is passed as its access token", () => {
    expect(
      parseAuthExport([
        MUNITO_ENTRY,
        {
          id: "cred_o",
          integrationID: "opencode",
          label: "atvari",
          active: true,
          value: {
            type: "oauth",
            methodID: "device",
            refresh: "rt_x",
            access: "st_x",
            expires: 1793898473131,
            metadata: { server: "https://opencode.ai/console" },
          },
        },
      ]),
    ).toBe("st_x")
  })

  test("a console API key (type key) is used when present", () => {
    expect(
      parseAuthExport([
        {
          id: "cred_k",
          integrationID: "opencode",
          label: "atvari",
          active: true,
          value: { type: "key", key: "sk_x" },
        },
      ]),
    ).toBe("sk_x")
  })

  test("other integrations, inactive entries and unknown shapes are ignored", () => {
    expect(
      parseAuthExport([
        MUNITO_ENTRY,
        {
          id: "cred_i",
          integrationID: "opencode",
          label: "atvari",
          active: false,
          value: { type: "oauth", access: "st_off" },
        },
        {
          id: "cred_u",
          integrationID: "opencode",
          label: "atvari",
          active: true,
          value: { type: "wellknown" },
        },
      ]),
    ).toBeUndefined()
  })

  test("malformed input yields undefined, never a throw", () => {
    expect(parseAuthExport(undefined)).toBeUndefined()
    expect(parseAuthExport(null)).toBeUndefined()
    expect(parseAuthExport({})).toBeUndefined()
    expect(parseAuthExport([null, 42 as any, "x"])).toBeUndefined()
  })
})

describe("jevAuthError", () => {
  test("the endpoint's own diagnostic wins", () => {
    expect(jevAuthError(401, "This API key has expired.")).toBe(
      "jev: 401 - This API key has expired.",
    )
  })

  test("401 falls back to credential rejection with the pairing hint", () => {
    expect(jevAuthError(401, "")).toBe(
      "jev: 401 - credential rejected (expired key or wrong deployment: key and endpoint must come from the same deployment)",
    )
  })

  test("402 reads as lack of funds, never as a pairing problem", () => {
    expect(jevAuthError(402, "")).toBe(
      "jev: 402 - insufficient funds on the Console inference account (top up in the OpenCode Console)",
    )
  })

  test("403 falls back to the pairing rule", () => {
    expect(jevAuthError(403, "")).toBe(
      "jev: 403 - endpoint refused the request (key and endpoint must come from the same deployment)",
    )
  })

  test("other statuses read as upstream failures, with detail when present", () => {
    expect(jevAuthError(500, "")).toBe("jev: upstream 500")
    expect(jevAuthError(502, "Upstream request failed")).toBe(
      "jev: upstream 502 - Upstream request failed",
    )
  })
})

describe("credentialRejected", () => {
  test("401 is always a credential rejection", () => {
    expect(credentialRejected(401, "")).toBe(true)
    expect(credentialRejected(401, "This API key has expired.")).toBe(true)
  })

  test("the Console's expired-key diagnostic matches on any status", () => {
    expect(credentialRejected(422, "This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.")).toBe(true)
    expect(credentialRejected(422, "the API key has been revoked")).toBe(true)
    expect(credentialRejected(200, "your session token is invalid")).toBe(true)
    expect(credentialRejected(400, "question must have a type")).toBe(false)
    expect(credentialRejected(400, "invalid model for this deployment")).toBe(false)
  })

  test("the 422 upstream-unavailable wrap matches (observed stale-key surface)", () => {
    expect(credentialRejected(422, "Upstream request failed: Endpoint is unavailable.")).toBe(true)
  })

  test("funds, pairing gates, plain outages and successes do not", () => {
    expect(credentialRejected(402, "insufficient funds on the Console inference account")).toBe(false)
    expect(credentialRejected(403, "endpoint refused the request")).toBe(false)
    expect(credentialRejected(500, "something crashed upstream")).toBe(false)
    expect(credentialRejected(200, "")).toBe(false)
  })
})

describe("normaliseProvider", () => {
  test("known providers pass through", () => {
    expect(normaliseProvider("opencode")).toBe("opencode")
    expect(normaliseProvider("opencode-go")).toBe("opencode-go")
  })

  test("unknown, non-string and unset values fall back to undefined", () => {
    expect(normaliseProvider(undefined)).toBeUndefined()
    expect(normaliseProvider("go")).toBeUndefined()
    expect(normaliseProvider("opencode-go/")).toBeUndefined()
    expect(normaliseProvider(42 as any)).toBeUndefined()
    expect(normaliseProvider({ provider: "opencode-go" } as any)).toBeUndefined()
  })
})
