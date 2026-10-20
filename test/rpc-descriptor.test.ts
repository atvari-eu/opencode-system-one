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
  })

  test("hosts without the Rpc class fall back to the structural descriptor", async () => {
    mock.module("@opencode/plugin/rpc", () => ({ nothingHere: true }))
    try {
      const definition: any = await makeJevRpc()
      expect(definition.id).toBe(JEV_RPC_ID)
      expect(definition.methods.describe).toBeDefined()
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
