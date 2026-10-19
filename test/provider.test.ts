// Provider deployment tests: provider option parsing, the registry-based
// endpoint derivation, credential chains, failure classification, init-fault
// composition and the surfacing gates. Pure logic, no plugin host, no network.

import { describe, expect, test } from "bun:test"
import {
  classifyJevFailure,
  CONSOLE_SYSTEMONE,
  credentialChain,
  deployFaultText,
  deploymentFingerprint,
  inlineScreenFailure,
  jevUserError,
  parseProviderOption,
  sessionSurfaceKey,
  systemoneRoute,
  type ProviderOption,
} from "../src/logic"

describe("parseProviderOption", () => {
  test("console ids", () => {
    expect(parseProviderOption("opencode")).toEqual({ kind: "console", id: "opencode" })
    expect(parseProviderOption("opencode-go")).toEqual({ kind: "console", id: "opencode-go" })
  })

  test("any other id is a host-registered provider, resolved through the registry", () => {
    expect(parseProviderOption("munito")).toEqual({ kind: "host", id: "munito" })
    expect(parseProviderOption("console-munito-eu")).toEqual({
      kind: "host",
      id: "console-munito-eu",
    })
  })

  test("http(s) URL becomes an explicit endpoint, trailing slash trimmed", () => {
    expect(
      parseProviderOption("https://api.example.com/inference/v1/systemone"),
    ).toEqual({
      kind: "custom",
      endpoint: "https://api.example.com/inference/v1/systemone",
    })
    expect(parseProviderOption("https://api.example.com/x/")?.endpoint).toBe(
      "https://api.example.com/x",
    )
  })

  test("plain http only for loopback hosts", () => {
    expect(parseProviderOption("http://127.0.0.1:8080/v1/systemone")?.kind).toBe("custom")
    expect(parseProviderOption("http://localhost:8080/v1/systemone")?.kind).toBe("custom")
    expect(parseProviderOption("http://api.example.com/v1/systemone")).toBeUndefined()
  })

  test("unknown shapes stay undefined, never guessed", () => {
    expect(parseProviderOption("")).toBeUndefined()
    expect(parseProviderOption("   ")).toBeUndefined()
    expect(parseProviderOption(undefined)).toBeUndefined()
    expect(parseProviderOption(42)).toBeUndefined()
    expect(parseProviderOption("https://a.example.com/x?query=1")).toBeUndefined()
    expect(parseProviderOption("https://")).toBeUndefined()
  })
})

describe("systemoneRoute", () => {
  test("appends the System One route to a deployment base", () => {
    expect(systemoneRoute("https://api.example.com/inference/v1")).toBe(
      "https://api.example.com/inference/v1/systemone",
    )
    expect(systemoneRoute("https://api.example.com/inference/v1/")).toBe(
      "https://api.example.com/inference/v1/systemone",
    )
  })

  test("a base already ending in the route stays as given", () => {
    expect(systemoneRoute("https://api.example.com/inference/v1/systemone")).toBe(
      "https://api.example.com/inference/v1/systemone",
    )
  })
})

describe("credentialChain", () => {
  test("console opencode: Console chain (TYPESAFE then OPENCODE env, CLI 'opencode', legacy entry)", () => {
    expect(credentialChain({ kind: "console", id: "opencode" })).toEqual({
      envKeys: ["TYPESAFE_API_KEY", "OPENCODE_API_KEY"],
      cliIntegration: "opencode",
      legacyId: "opencode",
    })
  })

  test("opencode-go: Go env key, same Console CLI integration, own legacy entry", () => {
    expect(credentialChain({ kind: "console", id: "opencode-go" })).toEqual({
      envKeys: ["OPENCODE_GO_API_KEY"],
      cliIntegration: "opencode",
      legacyId: "opencode-go",
    })
  })

  test("host ids pair with their own integration (CLI store lists logged-in providers)", () => {
    expect(credentialChain({ kind: "host", id: "munito" })).toEqual({
      envKeys: ["TYPESAFE_API_KEY"],
      cliIntegration: "munito",
      legacyId: "munito",
    })
  })

  test("explicit URLs carry no id - only the deployment-agnostic env key", () => {
    expect(credentialChain({ kind: "custom", endpoint: "https://x/y" })).toEqual({
      envKeys: ["TYPESAFE_API_KEY"],
      cliIntegration: undefined,
      legacyId: undefined,
    })
  })

  test("undefined option = default Console deployment", () => {
    expect(credentialChain(undefined)).toEqual(credentialChain({ kind: "console", id: "opencode" }))
  })
})

describe("console System One endpoint", () => {
  test("the Console chat baseURL does not serve System One - the product route is baked", () => {
    expect(CONSOLE_SYSTEMONE).toBe("https://opencode.ai/inference/systemone/v1/systemone")
    expect(systemoneRoute("https://opencode.ai/inference/openai/v1")).not.toBe(CONSOLE_SYSTEMONE)
  })
})

describe("classifyJevFailure", () => {
  test("400 + model diagnostic classifies as model-missing", () => {
    expect(classifyJevFailure("jev: upstream 400 - Model is unavailable")).toEqual({
      status: 400,
      detail: "Model is unavailable",
      kind: "model",
    })
  })

  test("credential, funds, gate buckets by status", () => {
    expect(classifyJevFailure("jev: 401 - credential rejected (expired key)").kind).toBe("credential")
    expect(classifyJevFailure("jev: 402 - insufficient funds").kind).toBe("funds")
    expect(classifyJevFailure("jev: 403 - endpoint refused the request").kind).toBe("gate")
  })

  test("the Console 422 upstream wrap is an outage, never a credential class", () => {
    expect(
      classifyJevFailure("jev: upstream 422 - Upstream request failed: Endpoint is unavailable")
        .kind,
    ).toBe("outage")
  })

  test("5xx and outage diagnostics classify as outage", () => {
    expect(classifyJevFailure("jev: upstream 503 - Service Unavailable").kind).toBe("outage")
  })

  test("everything else stays unknown", () => {
    // 405 < 500, no outage hint
    expect(classifyJevFailure("jev: upstream 405 - Method Not Allowed").kind).toBe("unknown")
    // 400 without a model-relative diagnostic
    expect(classifyJevFailure("jev: upstream 400 - Bad Request").kind).toBe("unknown")
    // no status code in the text
    expect(classifyJevFailure("jev: malformed response (no answers")).toEqual({
      status: undefined,
      detail: "",
      kind: "unknown",
    })
  })
})

describe("deployFaultText", () => {
  const fault = (kind: Parameters<typeof deployFaultText>[0], detail?: string) =>
    deployFaultText(kind, { host: "api.example.com", model: "m-1", detail })

  test("model fault names model and host, surfaces to the per-session row title", () => {
    const { message, surface } = fault("model", "unknown model")
    expect(message).toContain("m-1")
    expect(message).toContain("api.example.com")
    expect(jevUserError(surface)?.title).toBe("jev: judgment model not available at this deployment")
  })

  test("credential, funds and gate surfaces class into the existing user-error titles", () => {
    expect(jevUserError(fault("credential").surface)).toMatchObject({ title: expect.stringContaining("401") })
    expect(jevUserError(fault("funds", "insufficient funds").surface)).toMatchObject({
      title: expect.stringContaining("402"),
    })
    expect(jevUserError(fault("gate").surface)).toMatchObject({ title: expect.stringContaining("403") })
  })

  test("no-credential surface classes into the no-credential row", () => {
    expect(jevUserError(fault("no-credential").surface)).toMatchObject({
      title: expect.stringContaining("no credential"),
    })
  })

  test("outage and unknown faults stay console-only (no row class)", () => {
    expect(jevUserError(fault("outage", "gateway timeout").surface)).toBeUndefined()
    expect(jevUserError(fault("unknown", "weird body").surface)).toBeUndefined()
  })

  test("no-credential message points at the env chain", () => {
    expect(fault("no-credential").message).toContain("env key")
    expect(fault("no-credential").message).toContain("TYPESAFE_API_KEY")
  })

  test("no-endpoint fault names the unresolved provider id", () => {
    const Fault = deployFaultText("no-endpoint", { host: "munito", model: "m-1" })
    expect(Fault.message).toContain("munito")
  })
})

describe("surfacing gates", () => {
  test("sessionSurfaceKey includes session, error kind and deployment fingerprint", () => {
    expect(sessionSurfaceKey(undefined, "k", "fp")).toBe("-|k|fp")
    const same = sessionSurfaceKey("ses_1", "k", "fp1")
    expect(sessionSurfaceKey("ses_1", "k", "fp1")).toBe(same)
    // config change resets, new session resets, new kind resets
    expect(sessionSurfaceKey("ses_1", "k", "fp2")).not.toBe(same)
    expect(sessionSurfaceKey("ses_2", "k", "fp1")).not.toBe(same)
    expect(sessionSurfaceKey("ses_1", "other", "fp1")).not.toBe(same)
  })

  test("inlineScreenFailure: fetched web tools only", () => {
    expect(inlineScreenFailure("webfetch")).toBe(true)
    expect(inlineScreenFailure("websearch")).toBe(true)
    for (const tool of ["shell", "read", "grep", "glob", "edit", "write", "bash", "mcp__x__y"]) {
      expect(inlineScreenFailure(tool)).toBe(false)
    }
  })
})

describe("deploymentFingerprint", () => {
  test("stable per endpoint+model, differs across either", () => {
    const a = deploymentFingerprint("https://a", "m1")
    expect(deploymentFingerprint("https://a", "m1")).toBe(a)
    expect(deploymentFingerprint("https://b", "m1")).not.toBe(a)
    expect(deploymentFingerprint("https://a", "m2")).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("jevUserError on live deployment diagnostics", () => {
  test("the current console 400-model wrap surfaces as model-missing", () => {
    expect(
      jevUserError("jev: upstream 400 - Upstream request failed: Model is unavailable")?.title,
    ).toBe("jev: judgment model not available at this deployment")
  })

  test("screen-failure wrapping preserves the underlying classification", () => {
    expect(
      jevUserError("screen unavailable for shell: jev: 401 - credential rejected")?.title,
    ).toContain("401")
  })
})

// keep the ProviderOption type import used (compile-shape sanity)
const optionShape: ProviderOption = { kind: "host", id: "x" }
test("ProviderOption shape", () => expect(optionShape.kind).toBe("host"))
