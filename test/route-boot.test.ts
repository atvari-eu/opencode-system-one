// Runtime regression tests for auto-entry routing right after boot.
//
// Lived bug: choosing "Auto" and sending the first prompt of a fresh session
// right after OpenCode started failed with ConnectionRefused. Two causes:
//  1. providers activate asynchronously, so the first prompt saw an empty
//     model catalog and dropped every candidate as "absent from this domain"
//     - and the miss was memoized, poisoning every later prompt too;
//  2. a fresh session has no last-used real model, so the emergency chain
//     had nothing to fall back to and the turn executed on the pseudo-entry.
//
// The judge endpoint is a refused port (fast failure, no network), so the
// routing must recover without any verdict: a turn is never left on auto.

import { afterAll, describe, expect, test } from "bun:test"

process.env.JEV_ENDPOINT = "http://127.0.0.1:1/"
process.env.OPENCODE_BIN = "/bin/false"

const AUTO = { providerID: "opencode-system-one", id: "auto" }

function makeHost(opts: { catalogAfterMs: number; catalog: any[]; candidates?: string[]; rejectSwitchTo?: string }) {
  const startedAt = Date.now()
  const calls: Array<{ providerID: string; id: string; variant?: string }> = []
  const attempts: Array<{ providerID: string; id: string; variant?: string }> = []
  let promptHook: ((event: any) => Promise<void>) | undefined
  let listCalls = 0

  const noopEditor = {
    namespace: () => {},
    add: () => {},
    remove: () => {},
    set: () => {},
    update: () => {},
    list: () => [],
    get: () => undefined,
    default: () => {},
  }

  const ctx: any = {
    options: {
      screen: { enabled: false },
      auto: { candidates: opts.candidates ?? ["munito/cheap"] },
    },
    location: { directory: "/tmp/jev-route-boot" },
    app: { version: "0.0.0-test" },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    session: {
      hook: async (name: string, fn: any) => {
        if (name === "prompt") promptHook = fn
        return undefined
      },
      get: async () => ({ data: { model: AUTO } }),
      context: async () => [],
      switchModel: async (input: any) => {
        attempts.push({ ...input.model })
        if (opts.rejectSwitchTo && input.model.id === opts.rejectSwitchTo) {
          throw new Error("model not registered for switching yet")
        }
        calls.push({ ...input.model })
      },
      synthetic: async () => {},
      prompt: async () => ({}),
      generate: async () => ({ text: "" }),
      command: async () => ({}),
      compact: async () => ({}),
      create: async () => ({}),
    },
    tool: {
      transform: async (cb: any) => cb(noopEditor),
      hook: async () => undefined,
      list: async () => [],
    },
    command: { transform: async (cb: any) => cb(noopEditor), list: async () => [] },
    model: {
      list: async () => {
        listCalls += 1
        return { data: Date.now() - startedAt >= opts.catalogAfterMs ? opts.catalog : [] }
      },
      get: async () => null,
      transform: async (cb: any) => cb(noopEditor),
    },
    provider: { transform: async (cb: any) => cb(noopEditor), get: async () => null, list: async () => [] },
    event: { subscribe: async function* () {}, hook: async () => undefined, publish: async () => {} },
    permission: { hook: async () => undefined, askDecision: async () => null },
    rpc: { call: async () => null },
  }

  return {
    ctx,
    calls,
    attempts,
    listCalls: () => listCalls,
    firePrompt: async (text: string) => {
      if (!promptHook) throw new Error("prompt hook was not registered")
      await promptHook({ sessionID: "ses_boot", prompt: { text } })
    },
  }
}

const plugin = (await import("../src/index.ts")).default

async function setup(host: ReturnType<typeof makeHost>) {
  await plugin.setup(host.ctx)
  return host
}

afterAll(() => {
  delete process.env.JEV_ENDPOINT
  delete process.env.OPENCODE_BIN
})

describe("auto-entry routing right after boot", () => {
  test("first prompt waits out an empty catalog and switches to a usable candidate", async () => {
    const host = await setup(
      makeHost({ catalogAfterMs: 250, catalog: [{ providerID: "munito", id: "cheap", variants: [] }] }),
    )

    await host.firePrompt("fix the failing test")

    // Without the boot-lag wait the catalog was empty, every candidate was
    // dropped, and no switch happened - the turn ran on the closed-port entry.
    expect(host.calls.length).toBeGreaterThan(0)
    expect(host.calls[0]).toMatchObject({ providerID: "munito", id: "cheap" })
    expect(host.listCalls()).toBeGreaterThan(1)
  })

  test("a candidate missed on the first prompt resolves on the next one (no poisoned cache)", async () => {
    // The catalog arrives after the bounded wait, and its first candidate is
    // flagged unusable - so the second prompt can only land on "smart" if
    // "smart" was re-validated instead of served from a cached boot-time miss.
    const host = await setup(
      makeHost({
        catalogAfterMs: 3_500,
        candidates: ["munito/cheap", "munito/smart"],
        catalog: [
          { providerID: "munito", id: "cheap", enabled: false, variants: [] },
          { providerID: "munito", id: "smart", variants: [] },
        ],
      }),
    )

    await host.firePrompt("first prompt")
    expect(host.calls.length).toBeGreaterThan(0)

    await new Promise((resolve) => setTimeout(resolve, 3_600))
    const before = host.calls.length
    await host.firePrompt("second prompt")
    expect(host.calls.length).toBeGreaterThan(before)
    // The poisoned-cache bug kept "smart" null forever, so the last-resort
    // path would have retried the disabled "cheap" instead.
    expect(host.calls[host.calls.length - 1]).toMatchObject({ providerID: "munito", id: "smart" })
  }, 15_000)

  test("a rejected switch falls through to the next usable candidate", async () => {
    const host = await setup(
      makeHost({
        catalogAfterMs: 0,
        candidates: ["munito/cheap", "munito/smart"],
        catalog: [
          { providerID: "munito", id: "cheap", variants: [] },
          { providerID: "munito", id: "smart", variants: [] },
        ],
        rejectSwitchTo: "cheap",
      }),
    )

    await host.firePrompt("first prompt")

    // The judge is unreachable, so the first candidate is the last resort;
    // when the host refuses it, the session must not stay on the auto entry.
    expect(host.attempts.map((a) => a.id)).toEqual(["cheap", "smart"])
    expect(host.calls.map((c) => c.id)).toEqual(["smart"])
  })
})
