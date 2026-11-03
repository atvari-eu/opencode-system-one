import { describe, expect, mock, test } from "bun:test"
import { JEV_MODEL_STORE_KEY, JEV_RPC_ID, jevRpcClientOf, makeJevRpc } from "../src/rpc"

// Deterministic host shapes for the dynamic "@opencode/plugin/rpc" import:
// one test mocks the Rpc.define passthrough, another mocks a module without
// Rpc so the structural fallback path runs. (mock.module takes a factory.)
mock.module("@opencode/plugin/rpc", () => ({
  Rpc: { define: (definition: unknown): unknown => definition },
}))

describe("makeJevRpc", () => {
  test("defines the jev-config descriptor with describe/set/reset", async () => {
    const definition: any = await makeJevRpc()
    expect(definition.id).toBe(JEV_RPC_ID)
    for (const method of ["describe", "set", "reset"]) {
      expect(definition.methods[method]).toBeDefined()
    }
    expect(definition.methods.describe.output.required).toContain("base")
    expect(definition.methods.describe.output.required).toContain("models")
    expect(definition.methods.set.input.required).toEqual(["sessionID", "model"])
    expect(definition.methods.reset.input.required).toEqual(["sessionID"])
    expect(definition.methods.configFault).toBeDefined()
    expect(definition.methods.status).toBeDefined()
    expect(definition.methods.status.output.required).toContain("pools")
    const poolSchema = definition.methods.status.output.properties.pools.items
    expect(poolSchema.properties.name).toBeDefined()
    expect(poolSchema.properties.shape).toBeDefined()
    expect(poolSchema.required).not.toContain("shape")
    expect(poolSchema.properties.reason).toBeDefined()
    expect(definition.methods.status.output.properties.health.required).toEqual(["ok", "events"])
    expect(definition.methods.status.output.properties.health.properties.checkedAt).toBeDefined()
    expect(definition.methods.status.output.properties.session).toBeDefined()
    expect(definition.methods.status.output.properties.auth).toBeDefined()
  })

  test("declares the transcript-free screen event", async () => {
    const definition: any = await makeJevRpc()
    const screen = definition.events?.screen?.schema
    expect(screen).toBeDefined()
    expect(screen.required).toEqual(["tool", "verdict"])
    expect(screen.properties.verdict.enum).toEqual(["pass", "flagged", "unsafe", "error"])
    expect(screen.properties.call).toBeDefined()
    expect(screen.properties.preview).toBeDefined()
    expect(screen.properties.tool).toBeDefined()
    expect(screen.additionalProperties).toBe(false)
  })

  test("declares the transcript-free error event", async () => {
    const definition: any = await makeJevRpc()
    const error = definition.events?.error?.schema
    expect(error).toBeDefined()
    expect(error.required).toEqual(["message"])
    expect(error.additionalProperties).toBe(false)
  })

  test("declares the config and scrub UI events", async () => {
    const definition: any = await makeJevRpc()
    expect(definition.events?.config?.schema?.required).toEqual(["message"])
    expect(definition.events?.config?.schema?.properties?.fingerprint).toBeDefined()
    const scrub = definition.events?.scrub?.schema
    expect(scrub).toBeDefined()
    expect(scrub.required).toEqual(["kind", "hits"])
    expect(scrub.properties.kind.enum).toEqual(["tool", "prompt"])
    expect(scrub.additionalProperties).toBe(false)
  })

  test("declares the approval UI event", async () => {
    const definition: any = await makeJevRpc()
    const approval = definition.events?.approval?.schema
    expect(approval).toBeDefined()
    expect(approval.required).toEqual(["action", "outcome"])
    expect(approval.properties.outcome.enum).toEqual(["allow", "ask", "deny", "gate", "fail"])
    expect(approval.additionalProperties).toBe(false)
  })

  test("hosts without the Rpc class fall back to the structural descriptor", async () => {
    mock.module("@opencode/plugin/rpc", () => ({ nothingHere: true }))
    try {
      const definition: any = await makeJevRpc()
      expect(definition.id).toBe(JEV_RPC_ID)
      expect(definition.methods.describe).toBeDefined()
      // events ride the same structural shape so older build paths still
      // register the TUI channel when the host exposes it
      expect(definition.events.screen).toBeDefined()
      expect(definition.events.error).toBeDefined()
      expect(definition.events.config).toBeDefined()
      expect(definition.events.scrub).toBeDefined()
      expect(definition.events.approval).toBeDefined()
    } finally {
      mock.module("@opencode/plugin/rpc", () => ({
        Rpc: { define: (definition: unknown): unknown => definition },
      }))
    }
  })
})

describe("jevRpcClientOf", () => {
  test("hands the descriptor to client.rpc and returns the subclient", async () => {
    let received: unknown
    const subclient = { describe: async () => ({}) }
    const context = {
      client: {
        rpc: (definition: unknown) => {
          received = definition
          return subclient
        },
      },
    }
    expect(await jevRpcClientOf(context)).toBe(subclient)
    expect((received as any)?.id).toBe(JEV_RPC_ID)
  })

  test("missing client surface degrades to undefined", async () => {
    expect(await jevRpcClientOf({})).toBeUndefined()
    expect(await jevRpcClientOf({ client: {} })).toBeUndefined()
  })

  test("rpc construction failures degrade to undefined", async () => {
    expect(
      await jevRpcClientOf({
        client: {
          rpc: () => {
            throw new Error("no rpc for you")
          },
        },
      }),
    ).toBeUndefined()
  })
})

test("the label store key stays stable for cross-release store reads", () => {
  expect(JEV_MODEL_STORE_KEY).toBe("jev-model-label")
})
