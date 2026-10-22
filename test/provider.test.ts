// Provider deployment tests: provider option parsing, the registry-based
// endpoint derivation, credential chains, failure classification, init-fault
// composition and the surfacing titles. Pure logic, no plugin host, no network.

import { describe, expect, test } from "bun:test"
import {
  classifyJevFailure,
  CONSOLE_SYSTEMONE,
  credentialChain,
  deployFaultText,
  deploymentFingerprint,
  findRegistryProvider,
  inlineScreenFailure,
  jevUserError,
  parseProviderOption,
  providerInfoBaseURL,
  resolveProviderBaseURL,
  surfaceTitle,
  systemoneRoute,
  type ProviderOption,
} from "../src/logic"

describe("parseProviderOption", () => {
  test("console ids", () => {
    expect(parseProviderOption("opencode")).toEqual({ kind: "console", id: "opencode" })
    expect(parseProviderOption("opencode-go")).toEqual({ kind: "console", id: "opencode-go" })
  })

  test("any other id is a host-registered provider, resolved through the registry", () => {
    expect(parseProviderOption("acme")).toEqual({ kind: "host", id: "acme" })
    expect(parseProviderOption("console-acme-eu")).toEqual({
      kind: "host",
      id: "console-acme-eu",
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

describe("provider registry reading", () => {
  test("providerInfoBaseURL reads settings.baseURL, direct or {data}-wrapped", () => {
    expect(
      providerInfoBaseURL({ id: "munito", settings: { baseURL: "https://api.example.com/v1" } }),
    ).toBe("https://api.example.com/v1")
    expect(
      providerInfoBaseURL({
        data: { id: "munito", settings: { baseURL: "https://api.example.com/v1" } },
      }),
    ).toBe("https://api.example.com/v1")
  })

  test("providerInfoBaseURL rejects unknown shapes, empty or non-string urls", () => {
    expect(providerInfoBaseURL(undefined)).toBeUndefined()
    expect(providerInfoBaseURL("munito")).toBeUndefined()
    expect(providerInfoBaseURL({ settings: {} })).toBeUndefined()
    expect(providerInfoBaseURL({ settings: { baseURL: "   " } })).toBeUndefined()
    expect(providerInfoBaseURL({ settings: { baseURL: 42 } })).toBeUndefined()
  })

  test("findRegistryProvider scans an array list by id", () => {
    const list = [
      { id: "opencode", settings: {} },
      { id: "munito", settings: { baseURL: "https://api.example.com/v1" } },
    ]
    expect(findRegistryProvider(list, "munito")).toEqual(list[1])
    expect(findRegistryProvider(list, "acme")).toBeUndefined()
  })

  test("findRegistryProvider accepts map/lists/{data}-wrapped shapes", () => {
    const entry = { id: "munito", settings: { baseURL: "https://api.example.com/v1" } }
    expect(findRegistryProvider({ munito: entry }, "munito")).toEqual(entry)
    expect(findRegistryProvider({ data: [entry] }, "munito")).toEqual(entry)
    expect(findRegistryProvider(null, "munito")).toBeUndefined()
    expect(findRegistryProvider(42, "munito")).toBeUndefined()
  })
})

describe("resolveProviderBaseURL (plugin ctx)", () => {
  const entry = { id: "munito", settings: { baseURL: "https://api.example.com/v1" } }

  test("object-shaped get({providerID}) resolves directly", async () => {
    const calls: any[] = []
    const ctx = {
      provider: { get: async (arg: any) => (calls.push(arg), { data: entry }) },
    }
    expect(await resolveProviderBaseURL(ctx, "munito")).toBe("https://api.example.com/v1")
    expect(calls).toEqual([{ providerID: "munito" }])
  })

  test("schema rejection on the object shape falls through to the legacy string shape", async () => {
    const calls: any[] = []
    const ctx = {
      provider: {
        get: async (arg: any) => {
          calls.push(arg)
          if (typeof arg !== "string") throw new Error("SchemaError(Expected object)")
          return entry
        },
      },
    }
    expect(await resolveProviderBaseURL(ctx, "munito")).toBe("https://api.example.com/v1")
    expect(calls).toEqual([{ providerID: "munito" }, "munito"])
  })

  test("both get shapes missing the id fall through to list() (array or {data}", async () => {
    for (const listValue of [[entry], { data: [entry] }]) {
      const calls: any[] = []
      const ctx = {
        provider: {
          get: async (arg: any) => {
            calls.push(arg)
            throw new Error(`Provider not found: ${typeof arg === "string" ? arg : arg.providerID}`)
          },
          list: async () => listValue,
        },
      }
      expect(await resolveProviderBaseURL(ctx, "munito")).toBe("https://api.example.com/v1")
      expect(calls).toEqual([{ providerID: "munito" }, "munito"])
    }
  })

  test("get not found twice + list without the id resolves undefined", async () => {
    const ctx = {
      provider: {
        get: async () => {
          throw new Error("Provider not found: munito")
        },
        list: async () => [{ id: "opencode", settings: {} }],
      },
    }
    expect(await resolveProviderBaseURL(ctx, "munito")).toBeUndefined()
  })

  test("a non-shape get error is loud but still falls back to list", async () => {
    const ctx = {
      provider: {
        get: async () => {
          throw new Error("boom")
        },
        list: async () => ({ munito: entry }),
      },
    }
    expect(await resolveProviderBaseURL(ctx, "munito")).toBe("https://api.example.com/v1")
  })

  test("registry entry without settings.baseURL resolves undefined", async () => {
    const ctx = {
      provider: { list: async () => [{ id: "munito" }] },
    }
    expect(await resolveProviderBaseURL(ctx, "munito")).toBeUndefined()
  })

  test("no provider namespace at all resolves undefined", async () => {
    expect(await resolveProviderBaseURL({}, "munito")).toBeUndefined()
    expect(await resolveProviderBaseURL(undefined, "munito")).toBeUndefined()
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
    expect(credentialChain({ kind: "host", id: "acme" })).toEqual({
      envKeys: ["TYPESAFE_API_KEY"],
      cliIntegration: "acme",
      legacyId: "acme",
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

  test("outage and unknown faults have no polished title (surfaceTitle falls back to the raw text)", () => {
    expect(jevUserError(fault("outage", "gateway timeout").surface)).toBeUndefined()
    expect(jevUserError(fault("unknown", "weird body").surface)).toBeUndefined()
  })

  test("no-credential message points at the env chain", () => {
    expect(fault("no-credential").message).toContain("env key")
    expect(fault("no-credential").message).toContain("TYPESAFE_API_KEY")
  })

  test("no-endpoint fault names the unresolved provider id", () => {
    const Fault = deployFaultText("no-endpoint", { host: "acme", model: "m-1" })
    expect(Fault.message).toContain("acme")
  })
})

describe("surfacing", () => {
  test("surfaceTitle keeps the polished title for actionable classes", () => {
    expect(surfaceTitle("jev: 401 - credential rejected")).toBe(
      "jev: credential rejected (401) - expired session? run `opencode auth login` again",
    )
    expect(surfaceTitle("screen unavailable for shell: jev: 401 - credential rejected")).toContain("401")
  })

  test("surfaceTitle falls back to the flattened raw text otherwise", () => {
    expect(surfaceTitle("jev: upstream 500 - gateway timeout")).toBe("jev: upstream 500 - gateway timeout")
    expect(surfaceTitle("screen unavailable for webfetch:\n\tjev: upstream unavailable - answering slow")).toBe(
      "screen unavailable for webfetch: jev: upstream unavailable - answering slow",
    )
    expect(surfaceTitle("")).toBe("")
    expect(surfaceTitle(undefined)).toBe("")
  })

  test("surfaceTitle caps long diagnostics with the tail kept", () => {
    const long = `jev: upstream 500 - ${"x".repeat(400)} END`
    const title = surfaceTitle(long)
    expect(title.length).toBeLessThanOrEqual(300) // head + elision marker + tail
    expect(title).toContain("END")
    expect(title).toContain("chars]…")
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
