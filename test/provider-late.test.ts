// Runtime test for the boot-ordering race: drive the plugin's real setup()
// with a fake host context - no OpenCode, no network (fetch is stubbed to a
// Munito-shaped 401), no host credential store (PATH is emptied so no CLI
// binary spawns, HOME points at a fresh scratch dir for the legacy store).
//
// Simulated deployment: a locally configured provider ("munito") is ABSENT
// from the plugin registry at setup time (the config plugin registers later
// on some 2.0.x hosts) and PRESENT at the first judged call. The plugin has
// to resolve `settings.baseURL + /systemone` after boot, re-run the ping,
// and fail closed with the deployment's own fault - never the older "no
// endpoint resolved" one.
//
// Two credential scenarios, both deterministic:
//  - no credential anywhere: the judged surface is the "no credential" fault
//    (the chain's own remedy), and the ping goes out without auth
//  - an env key the endpoint rejects: the surface is the raw 401 rejection,
//    and the ping carries `Authorization: Bearer test-key`

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

const FETCHES: Array<{ url: string; auth: string | undefined }> = []
const SANDLE_ENV: Array<string> = []
const SCRATCH: string[] = []

function pinEnv(pairs: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(pairs)) {
    if (!SANDLE_ENV.includes(name)) SANDLE_ENV.push(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterAll(() => {
  for (const name of SANDLE_ENV) delete process.env[name]
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true })
})

function fakeHost(providerEntry: unknown, absentAtInit: boolean) {
  let phase = absentAtInit ? "init" : "boot"
  const registryGetCalls: unknown[] = []
  const registeredTools: any[] = []
  const noop = () => undefined
  const asyncNoop = async () => undefined

  const makeEditor = () => ({
    namespace: (ns: any) => void ns,
    add: (tool: any) => registeredTools.push(tool),
    remove: noop,
    set: noop,
    update: noop,
  })

  const namespaces: Record<string, any> = {
    storage: {
      get: async () => undefined,
      set: asyncNoop,
      store: async (_key: string, shard: any) => shard?.initial,
    },
    session: {
      hook: async () => () => undefined,
      get: async () => undefined,
      context: async () => [],
      synthetic: asyncNoop,
      switchModel: asyncNoop,
    },
    event: { hook: async () => () => undefined, publish: asyncNoop },
    model: {
      list: async () => ({ data: [] }),
      get: async () => null,
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
    },
    permission: {
      hook: async () => () => undefined,
      askDecision: async () => null,
    },
    integration: {
      transform: async (fn: any) => {
        await fn({ get: () => undefined, method: { update: noop }, update: noop })
      },
    },
    provider: {
      get: async (arg: any) => {
        registryGetCalls.push(arg)
        if (phase !== "boot") throw new Error("Provider not found: munito")
        const id = typeof arg === "string" ? arg : arg?.providerID
        if (id === "munito") return { data: providerEntry }
        throw new Error(`Provider not found: ${id}`)
      },
      list: async () => ({ data: phase === "boot" ? [providerEntry] : [] }),
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
      reload: asyncNoop,
    },
    command: { transform: async (fn: any) => { await fn(makeEditor()) } },
    agent: { transform: async (fn: any) => { await fn(makeEditor()) } },
    reference: { transform: async (fn: any) => { await fn(makeEditor()) } },
    skill: { transform: async (fn: any) => { await fn(makeEditor()) } },
    mcp: { transform: async (fn: any) => { await fn(makeEditor()) } },
    worktree: { transform: async (fn: any) => { await fn(makeEditor()) } },
    websearch: { transform: async (fn: any) => { await fn(makeEditor()) } },
    generate: { transform: async (fn: any) => { await fn(makeEditor()) } },
    credential: { transform: async (fn: any) => { await fn(makeEditor()) } },
    experimental: { transform: async (fn: any) => { await fn(makeEditor()) } },
    aisdk: { transform: async (fn: any) => { await fn(makeEditor()) } },
    vcs: { transform: async (fn: any) => { await fn(makeEditor()) } },
    shell: { transform: async (fn: any) => { await fn(makeEditor()) } },
    plugin: { transform: async (fn: any) => { await fn(makeEditor()) } },
    rpc: { call: asyncNoop },
    app: { info: async () => ({}) },
  }

  const ctx: any = {
    options: {
      provider: "munito",
      model: "perplexity-ai/pplx-decider-v1.2",
      screen: { enabled: true, mode: "annotate", tools: "all" },
    },
    location: { directory: "/tmp/jevtest" },
    client: undefined,
    tool: {
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
      hook: async (_name: string, _listener: any) => () => undefined,
    },
  }
  for (const [name, ns] of Object.entries(namespaces)) ctx[name] = ns

  return {
    ctx,
    state: {
      flipPhase: () => (phase = "boot"),
      screenTool: () => registeredTools.find((t) => t?.name === "screen"),
      registryGetCalls,
    },
  }
}

async function runScenario(
  credEnv: string | undefined,
  absentAtInit: boolean,
): Promise<{ thrown: string; fetches: typeof FETCHES }> {
  const home = mkdtempSync(join(tmpdir(), "jev-late-test-"))
  SCRATCH.push(home)
  pinEnv({
    PATH: "",
    HOME: home,
    TYPESAFE_API_KEY: credEnv,
    // Other test files pin these process-wide (host.test.ts); the scenario
    // must not inherit them.
    JEV_ENDPOINT: undefined,
    OPENCODE_BIN: undefined,
  })
  const entry = {
    id: "munito",
    settings: { baseURL: "https://api.eu.munito.ai/inference/v1" },
  }
  const host = fakeHost(entry, absentAtInit)
  const prevFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    FETCHES.push({
      url: String(url),
      auth: (init?.headers as any)?.Authorization,
    })
    return new Response(JSON.stringify({ detail: "Missing API key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const setup = (plugin as any)?.setup
    expect(typeof setup).toBe("function")
    // Init: the registry lookup misses and the plugin initializes
    // fail-closed without crashing and without pinging.
    await setup(host.ctx)
    if (absentAtInit) {
      expect(host.state.registryGetCalls.length).toBeGreaterThan(0)
      expect(FETCHES.length).toBe(0)
    }
    if (absentAtInit) host.state.flipPhase()

    let thrown = ""
    try {
      await host.state.screenTool().execute(
        { summary: "probe", content: "hello world" },
        { sessionID: "ses_test" },
      )
    } catch (err: any) {
      thrown = String(err?.message ?? err)
    }
    return { thrown, fetches: [...FETCHES], registryGetCalls: host.state.registryGetCalls }
  } finally {
    globalThis.fetch = prevFetch
  }
}

describe("plugin setup + late resolve (fake host, no network)", () => {
  test(
    "absent-at-init provider resolves after boot and noise-free pings without a credential",
    async () => {
      const before = FETCHES.length
      const { thrown, fetches, registryGetCalls } = await runScenario(undefined, true)
      const scenario = fetches.slice(before)

      // The judged gate retried the registry after "boot", resolved the
      // relative endpoint, pinged it, and surfaced the credential fault.
      expect(thrown).toContain("no credential")
      expect(thrown).not.toContain("no endpoint resolved")

      // Exactly one ping, at settings.baseURL + /systemone, without auth.
      expect(scenario.length).toBe(1)
      expect(scenario[0].url).toBe("https://api.eu.munito.ai/inference/v1/systemone")
      expect(scenario[0].auth).toBeUndefined()

      // The registry reads stay on the object shape ({ providerID }).
      expect(registryGetCalls.length).toBeGreaterThan(0)
      expect(registryGetCalls[registryGetCalls.length - 1]).toEqual({
        providerID: "munito",
      })
    },
  )

  test("an env key the endpoint rejects surfaces the raw 401, not no-credential", async () => {
    const before = FETCHES.length
    const { thrown, fetches, registryGetCalls } = await runScenario("test-key", false)
    const scenario = fetches.slice(before)

    expect(thrown).toContain("jev: 401")
    expect(thrown).not.toContain("no credential")
    expect(scenario.length).toBe(1)
    expect(scenario[0].url).toBe("https://api.eu.munito.ai/inference/v1/systemone")
    expect(scenario[0].auth).toBe("Bearer test-key")
    // Present at init: one registry read, no boot-ordering retry.
    expect(registryGetCalls).toEqual([{ providerID: "munito" }])
  })
})
