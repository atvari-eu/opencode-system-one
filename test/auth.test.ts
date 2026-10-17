// Auth plumbing tests: auth-export parsing and status-aware error text.
// Pure logic, no plugin host, no live jev, no subprocess.

import { describe, expect, test } from "bun:test"
import { jevAuthError, normaliseProvider, parseAuthExport } from "../src/logic"

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
