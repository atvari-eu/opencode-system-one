// Bypass tests: OpenCode 2-style permission rules ({ action, resource,
// effect }) resolved against approval requests. Ordered, glob resources,
// last match wins; unmatched requests fall through to jev.

import { describe, expect, test } from "bun:test"
import { bypassLookup, globMatches, parseBypassRules } from "../src/logic"

const shellGit = [
  {
    action: "shell",
    resource: "git push *",
    effect: "deny",
  },
] as const

describe("globMatches", () => {
  test("whole-value wildcard matches like OpenCode rules", () => {
    expect(globMatches("git push origin main", "git push *")).toBe(true)
    expect(globMatches("git status --short", "git push *")).toBe(false)
    expect(globMatches("git status", "git status *")).toBe(true)
    expect(globMatches("src/foo.md", "src/*.md")).toBe(true)
    expect(globMatches("src/foo.mdx", "src/*.md")).toBe(false)
    expect(globMatches("ab", "a?b")).toBe(false)
    expect(globMatches("ab", "a?")).toBe(true)
    expect(globMatches("sudo *", "sudo *")).toBe(true)
    expect(globMatches("sudo apt", "sudo *")).toBe(true)
    expect(globMatches("sudo", "sudo *")).toBe(true)
  })

  test("regex metacharacters in the glob are literal", () => {
    expect(globMatches("nix shell nixpkgs#uv", "nix shell *")).toBe(true)
    expect(globMatches("a.c", "a?")).toBe(false)
    expect(globMatches("abc", "a.c")).toBe(false)
    expect(globMatches("a.c", "a.c")).toBe(true)
  })
})

describe("parseBypassRules", () => {
  test("keeps well-formed rules, drops malformed ones", () => {
    expect(
      parseBypassRules([
        { action: "shell", resource: "git push *", effect: "deny" },
        { resource: "src/*.md", effect: "allow" },
        { resource: "", effect: "allow" },
        { resource: "x", effect: "maybe" },
        "git push *",
        null,
      ]),
    ).toEqual([
      { action: "shell", resource: "git push *", effect: "deny" },
      { action: "*", resource: "src/*.md", effect: "allow" },
    ])
  })

  test("non-arrays yield no rules", () => {
    expect(parseBypassRules(undefined)).toEqual([])
    expect(parseBypassRules("git push *")).toEqual([])
  })
})

describe("bypassLookup", () => {
  test("matching deny rule enacts deny only when configured", () => {
    expect(bypassLookup("shell", ["git push origin main"], [...shellGit])).toBe("deny")
  })

  test("non-matching requests fall through to jev", () => {
    expect(bypassLookup("shell", ["git status"], [...shellGit])).toBe(null)
    expect(bypassLookup("edit", ["git push *"], [...shellGit])).toBe(null)
  })

  test("rules apply in order and the last match wins", () => {
    const rules = parseBypassRules([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status *", effect: "ask" },
      { action: "shell", resource: "git diff *", effect: "ask" },
    ])
    expect(bypassLookup("shell", ["git diff --stat"], rules)).toBe("ask")
    expect(bypassLookup("shell", ["bun test"], rules)).toBe("ask")
  })

  test("bare * action matches every action", () => {
    const rules = parseBypassRules([{ resource: "raises/are/welcome", effect: "allow" }])
    expect(bypassLookup("shell", ["raises/are/welcome"], rules)).toBe("allow")
    expect(bypassLookup("edit", ["raises/are/welcome"], rules)).toBe("allow")
  })
})
