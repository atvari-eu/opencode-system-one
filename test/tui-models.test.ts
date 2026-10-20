import { describe, expect, mock, test } from "bun:test"
import { jevModelTag } from "../src/logic"
import { JEV_MODEL_STORE_KEY, type JevModelStore } from "../src/rpc"

// The TUI plugin setup dynamically imports the solid-JSX modules; stub them
// so tests never touch a JSX transform. footer-jev-model doubles as the
// picker's current-session source (sessionHolder).
const sessionHolder = { current: undefined as string | undefined }
const noopModule = { default: { id: "stub", setup: async () => async () => {} } }
mock.module("../src/screen-panel.tsx", () => noopModule)
mock.module("../src/footer-marker.tsx", () => noopModule)
mock.module("../src/footer-jev-model.tsx", () => ({
  default: { id: "stub.model", setup: async () => async () => {} },
  sessionHolder,
}))

interface ToastRow {
  title?: string
  message: string
  variant?: string
  duration?: number
}

function flush(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// "off" (rpc:false) means "host without the rpc surface"; any other value
// (an object parameter bag) means "rpc present".
function makeContext(overrides: { rpc?: boolean | object; dialog?: boolean }) {
  const toasts: ToastRow[] = []
  const stores = new Map<string, { value: JevModelStore; writes: number }>()
  const selectCalls: any[] = []
  const dialogClears: number[] = []
  const rpcDefinitions: unknown[] = []
  const calls: { describe: any[]; set: any[]; reset: any[] } = { describe: [], set: [], reset: [] }

  let pickValue: string | undefined
  let describeValue: any = { base: "jev-1.13-free", models: [{ id: "jev-1.13-free" }, { id: "jev-1.13" }] }
  let setResult: any = { ok: true }
  let resetResult: any = { ok: true }
  let routerSessionID: string | undefined = "s1"
  const context: any = {
    keymap: {
      layer: (build: () => any) => {
        const config = build()
        context.__commands = config.commands
        return async () => {}
      },
    },
    data: { on: () => () => {} },
    ui: {
      toast: { show: (row: ToastRow) => toasts.push(row) },
      router: {
        current: () => (routerSessionID === undefined ? {} : { data: { sessionID: routerSessionID } }),
      },
      ...(overrides.dialog
        ? {
            dialog: {
              select: async (options: any) => {
                selectCalls.push(options)
                return pickValue
              },
              clear: () => dialogClears.push(1),
            },
          }
        : {}),
    },
    storage: {
      store: (_key: string, options: { initial: JevModelStore }) => {
        let entry = stores.get(_key)
        if (!entry) {
          entry = { value: options.initial, writes: 0 }
          stores.set(_key, entry)
        }
        return [
          entry.value,
          (updater: (draft: JevModelStore) => void) => {
            entry!.writes++
            updater(entry!.value)
          },
        ] as const
      },
    },
    __commands: [] as any[],
  }
  if (overrides.rpc !== false) {
    context.client = {
      rpc: (definition: unknown) => {
        rpcDefinitions.push(definition)
        return {
          describe: async (input: any) => {
            calls.describe.push(input)
            return describeValue
          },
          set: async (input: any) => {
            calls.set.push(input)
            return setResult
          },
          reset: async (input: any) => {
            calls.reset.push(input)
            return resetResult
          },
        }
      },
    }
  }
  return {
    context,
    toasts,
    stores,
    selectCalls,
    dialogClears,
    calls,
    rpcDefinitions,
    setDescribe: (value: any) => (describeValue = value),
    setSetResult: (value: any) => (setResult = value),
    setPickValue: (value: string | undefined) => (pickValue = value),
    setRouterSession: (value: string | undefined) => (routerSessionID = value),
  }
}

async function setupCommand(overrides: Parameters<typeof makeContext>[0]) {
  const parts = makeContext(overrides)
  const tui = (await import("../src/tui.ts")).default
  parts.context.cleanup = await tui.setup(parts.context)
  const command = parts.context.__commands.find((c: any) => c.id === "jev.model")
  expect(command).toBeDefined()
  return { ...parts, command }
}

describe("/jev-models picker", () => {
  test("without the rpc client it toasts the remedy", async () => {
    const harness = await setupCommand({ rpc: false, dialog: true })
    harness.command.run("")
    await flush()
    const last = harness.toasts.at(-1)!
    expect(last.variant).toBe("warning")
    expect(last.message).toContain("rpc unavailable")
    await harness.context.cleanup()
  })

  test("without a session it toasts the guard", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = undefined
    harness.setRouterSession(undefined)
    harness.command.run("")
    await flush()
    expect(harness.toasts.at(-1)!.variant).toBe("warning")
    expect(harness.toasts.at(-1)!.message).toContain("no active session")
    await harness.context.cleanup()
  })

  test("direct text pick pins the model, toasts success and writes the label", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.command.run(" jev-1.13 ")
    await flush()
    expect(harness.calls.set).toEqual([{ sessionID: "s1", model: "jev-1.13" }])
    expect(harness.calls.reset.length).toBe(0)
    expect(harness.toasts.at(-1)!.variant).toBe("success")
    expect(harness.toasts.at(-1)!.message).toBe(`System One model for this session: ${jevModelTag("jev-1.13")}`)
    const label = harness.stores.get(JEV_MODEL_STORE_KEY)!
    expect(label.value.sessions?.["s1"]).toBe("jev-1.13")
    await harness.context.cleanup()
  })

  test("rejected pick keeps the label and reports the server's message", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.setSetResult({ ok: false, message: "404 unknown model" })
    harness.command.run("jev-x")
    await flush()
    expect(harness.calls.set).toEqual([{ sessionID: "s1", model: "jev-x" }])
    expect(harness.toasts.at(-1)!.variant).toBe("error")
    expect(harness.toasts.at(-1)!.message).toContain("404 unknown model")
    const label = harness.stores.get(JEV_MODEL_STORE_KEY)!
    expect(label.value.sessions?.["s1"]).toBeUndefined()
    await harness.context.cleanup()
  })

  test("'reset' argument clears the pin via the server and the label store", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.command.run("reset")
    await flush()
    expect(harness.calls.reset).toEqual([{ sessionID: "s1" }])
    expect(harness.stores.get(JEV_MODEL_STORE_KEY)!.value.sessions?.["s1"]).toBe("")
    await harness.context.cleanup()
  })

  test("dialog flow lists describe rows, current pick and the reset action", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.setDescribe({
      base: "jev-1.13-free",
      pick: "jev-1.13",
      models: [
        { id: "jev-1.13-free" },
        { id: "jev-1.13" },
        { id: "jev-broken", fault: "401 unauthorized" },
      ],
    })
    harness.command.run("")
    await flush(2)
    expect(harness.calls.describe).toEqual([{ sessionID: "s1" }])
    const dialogInput = harness.selectCalls.at(-1)!
    expect(dialogInput.options).toEqual([
      { title: "jev-1.13-free", value: "jev-1.13-free" },
      { title: "jev-1.13", value: "jev-1.13" },
      { title: "jev-broken", value: "jev-broken", description: "no: 401 unauthorized" },
    ])
    expect(dialogInput.current).toBe("jev-1.13")
    expect(dialogInput.actions[0].bind).toBe("ctrl+r")

    // escaping without a pick changes nothing
    harness.setPickValue(undefined)
    await flush()
    expect(harness.calls.set.length).toBe(0)
    await harness.context.cleanup()
  })

  test("closing with a pick applies it", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.setPickValue("jev-1.13-free")
    harness.command.run("")
    await flush(2)
    expect(harness.calls.set).toEqual([{ sessionID: "s1", model: "jev-1.13-free" }])
    expect(harness.stores.get(JEV_MODEL_STORE_KEY)!.value.sessions?.["s1"]).toBe("jev-1.13-free")
    await harness.context.cleanup()
  })

  test("the dialog's ctrl+r action resets pin and label, then clears the dialog", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = "s1"
    harness.setDescribe({ base: "jev-1.13-free", pick: "jev-1.13", models: [{ id: "jev-1.13" }] })
    harness.setPickValue(undefined)
    harness.command.run("")
    await flush(2)
    const action = harness.selectCalls.at(-1)!.actions[0]
    await action.onTrigger()
    expect(harness.calls.reset).toEqual([{ sessionID: "s1" }])
    expect(harness.dialogClears.length).toBe(1)
    expect(harness.stores.get(JEV_MODEL_STORE_KEY)!.value.sessions?.["s1"]).toBe("")
    await harness.context.cleanup()
  })

  test("no dialog surface toasts the direct-command remedy", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: false })
    sessionHolder.current = "s1"
    harness.command.run("")
    await flush()
    expect(harness.toasts.at(-1)!.variant).toBe("warning")
    expect(harness.toasts.at(-1)!.message).toContain('"/jev-models <model-id>"')
    await harness.context.cleanup()
  })

  test("falls back to the router when the footer holder has nothing", async () => {
    const harness = await setupCommand({ rpc: {}, dialog: true })
    sessionHolder.current = undefined
    harness.setRouterSession("s2")
    harness.command.run("jev-1.13")
    await flush()
    expect(harness.calls.set).toEqual([{ sessionID: "s2", model: "jev-1.13" }])
    await harness.context.cleanup()
  })
})
