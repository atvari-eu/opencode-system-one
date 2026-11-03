import { describe, expect, mock, test } from "bun:test"
import { STATUS_STORE_KEY, type StatusStore } from "../src/status"

// tui.ts statically imports the TSX modules; stub them so tests never touch a
// JSX transform. status-panel exports the refresh holder tui.ts fills in.
const statusRefresh: { current?: () => void } = {}
const sessionHolder = { current: undefined as string | undefined }
const noopModule = { default: { id: "stub", setup: async () => async () => {} } }
mock.module("../src/audit-panel.tsx", () => noopModule)
mock.module("../src/footer-marker.tsx", () => noopModule)
mock.module("../src/footer-jev-model.tsx", () => ({
  default: { id: "stub.model", setup: async () => async () => {} },
  sessionHolder,
}))
mock.module("../src/status-panel.tsx", () => ({
  default: { id: "stub.status", setup: async () => async () => {} },
  statusRefresh,
}))

function flush(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SNAPSHOT = {
  provider: "opencode",
  endpoint: "https://opencode.ai/inference/systemone/v1/systemone",
  model: "jev-1.13-free",
  catalog: "live" as const,
  health: { ok: true, events: true },
  models: [{ id: "jev-1.13-free" }],
  features: [{ name: "screen", state: "on" }],
  pools: [],
}

function makeContext(overrides: { rpc?: boolean; status?: (input: any) => Promise<any> }) {
  const toasts: any[] = []
  const stores = new Map<string, { value: any }>()
  const opened: string[] = []
  let closed = 0
  let current: string | undefined
  const rpcCalls: any[] = []
  const context: any = {
    keymap: {
      layer: (build: () => any) => {
        const config = build()
        context.__commands.push(...config.commands)
        return async () => {}
      },
    },
    data: { on: () => () => {} },
    ui: {
      toast: { show: (row: any) => toasts.push(row) },
      panel: {
        open: (name: string) => {
          opened.push(name)
          current = name
        },
        close: () => {
          closed++
          current = undefined
        },
        current: () => (current ? { name: current } : undefined),
      },
    },
    storage: {
      store: (key: string, options: { initial: any }) => {
        let entry = stores.get(key)
        if (!entry) {
          entry = { value: options.initial }
          stores.set(key, entry)
        }
        return [
          entry.value,
          (updater: (draft: any) => void) => updater(entry!.value),
        ] as const
      },
      memory: (_key: string, options: { initial: unknown }) => [
        options.initial,
        (mutation: (draft: unknown) => void) => mutation(options.initial),
      ],
    },
    __commands: [] as any[],
  }
  if (overrides.rpc !== false) {
    context.client = {
      rpc: () => ({
        configFault: async () => ({}),
        status: async (input: any) => {
          rpcCalls.push(input)
          return (overrides.status ?? (async () => SNAPSHOT))(input)
        },
      }),
    }
  }
  return {
    context,
    toasts,
    stores,
    opened,
    rpcCalls,
    closedCount: () => closed,
  }
}

async function setupCommand(overrides: Parameters<typeof makeContext>[0]) {
  const parts = makeContext(overrides)
  const tui = (await import("../src/tui.ts")).default
  parts.context.cleanup = await tui.setup(parts.context)
  const command = parts.context.__commands.find((c: any) => c.id === "jev.status")
  expect(command).toBeDefined()
  return { ...parts, command }
}

describe("/jev-status", () => {
  test("fetches a snapshot for the current session and opens the panel", async () => {
    const harness = await setupCommand({})
    sessionHolder.current = "s1"
    harness.command.run()
    await flush(2)
    expect(harness.rpcCalls).toEqual([{ sessionID: "s1" }])
    const store = harness.stores.get(STATUS_STORE_KEY)!.value as StatusStore
    expect(store.status?.provider).toBe("opencode")
    expect(store.error).toBeUndefined()
    expect(store.fetching).toBe(false)
    expect(store.at).toBeGreaterThan(0)
    expect(harness.opened).toEqual(["jev-status"])
    await harness.context.cleanup()
  })

  test("without a session it asks for the chain snapshot", async () => {
    const harness = await setupCommand({})
    sessionHolder.current = undefined
    harness.command.run()
    await flush(2)
    expect(harness.rpcCalls).toEqual([{}])
    await harness.context.cleanup()
  })

  test("a second run toggles the open panel closed", async () => {
    const harness = await setupCommand({})
    sessionHolder.current = "s1"
    harness.command.run()
    await flush(2)
    harness.command.run()
    await flush(2)
    expect(harness.closedCount()).toBe(1)
    expect(harness.opened).toEqual(["jev-status"])
    await harness.context.cleanup()
  })

  test("a failed refresh stores the reason and still opens the panel", async () => {
    const harness = await setupCommand({
      status: async () => {
        throw new Error("rpc exploded")
      },
    })
    sessionHolder.current = "s1"
    harness.command.run()
    await flush(2)
    const store = harness.stores.get(STATUS_STORE_KEY)!.value as StatusStore
    expect(store.error).toBe("rpc exploded")
    expect(store.status).toBeNull()
    expect(harness.opened).toEqual(["jev-status"])
    await harness.context.cleanup()
  })

  test("hosts without the rpc surface get a remedy in the store, not a toast", async () => {
    const harness = await setupCommand({ rpc: false })
    sessionHolder.current = "s1"
    harness.command.run()
    await flush(2)
    const store = harness.stores.get(STATUS_STORE_KEY)!.value as StatusStore
    expect(store.error).toContain("status unavailable")
    expect(harness.toasts).toEqual([])
    expect(harness.opened).toEqual(["jev-status"])
    await harness.context.cleanup()
  })

  test("the panel's refresh shortcut re-fetches through tui.ts", async () => {
    const harness = await setupCommand({})
    sessionHolder.current = "s1"
    harness.command.run()
    await flush(2)
    expect(harness.rpcCalls.length).toBe(1)
    statusRefresh.current?.()
    await flush(2)
    expect(harness.rpcCalls.length).toBe(2)
    await harness.context.cleanup()
  })
})
