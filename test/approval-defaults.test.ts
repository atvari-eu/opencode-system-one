// Built-in approval defaults: tool actions whose risk lives in the result
// are allowed without a judgment, and operator rules override them (the
// ruleset is ordered, last match wins).

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ALLOW_ACTIONS,
  DEFAULT_ALLOW_RULES,
  approvalRules,
  chainPermissionEffect,
  lookupPermission,
} from "../src/logic"

describe("built-in allow defaults", () => {
  test("cover the result-screened / re-permissioned tool actions", () => {
    expect([...DEFAULT_ALLOW_ACTIONS].sort()).toEqual(["question", "skill", "subagent", "webfetch", "websearch"])
    for (const action of DEFAULT_ALLOW_ACTIONS) {
      expect(lookupPermission(action, ["anything"], DEFAULT_ALLOW_RULES)?.effect).toBe("allow")
    }
  })

  test("do not leak onto mutating actions", () => {
    expect(lookupPermission("shell", ["rm -rf dist"], DEFAULT_ALLOW_RULES)).toBeNull()
    expect(lookupPermission("edit", ["src/a.ts"], DEFAULT_ALLOW_RULES)).toBeNull()
    expect(lookupPermission("write", ["src/a.ts"], DEFAULT_ALLOW_RULES)).toBeNull()
    expect(lookupPermission("read", ["src/a.ts"], DEFAULT_ALLOW_RULES)).toBeNull()
  })

  test("operator rules are appended and override the defaults", () => {
    const rules = approvalRules([
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "subagent", resource: "release-*", effect: "deny" },
    ])
    expect(lookupPermission("webfetch", ["https://x.dev"], rules)?.effect).toBe("ask")
    expect(lookupPermission("subagent", ["release-bot"], rules)?.effect).toBe("deny")
    // unmapped defaults still apply
    expect(lookupPermission("websearch", ["q"], rules)?.effect).toBe("allow")
    // chain resolution sees the operator's ask, not the default allow
    expect(chainPermissionEffect("webfetch", ["https://x.dev"], rules)).toBe("ask")
  })

  test("a global ask rule puts everything back under judgment", () => {
    const rules = approvalRules([{ action: "*", resource: "*", effect: "ask" }])
    expect(lookupPermission("webfetch", ["https://x.dev"], rules)?.effect).toBe("ask")
    expect(lookupPermission("question", ["*"], rules)?.effect).toBe("ask")
  })

  test("malformed entries are dropped without disturbing the defaults", () => {
    const rules = approvalRules([{ action: "webfetch", effect: "allow" }]) // no resource
    expect(lookupPermission("webfetch", ["https://x.dev"], rules)?.effect).toBe("allow")
  })
})
