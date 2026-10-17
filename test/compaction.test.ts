// Compaction pure helpers: host-injected system blocks never reach the
// rendered summary or the judged state; user/assistant replay is untouched.

import { describe, expect, test } from "bun:test"
import { renderSummary, collectCalls } from "../src/compaction"

const message = (role: "user" | "assistant" | "system", text: string): any => ({
  role,
  content: [{ type: "text", text }],
})

const SYSTEM_CATALOG =
  "The Code Mode tool catalog has changed. This catalog supersedes the previous one.\n\n# Code Mode\n\n## Available tools\n- execute"

describe("renderSummary", () => {
  test("host system blocks are excluded from the hook-supplied summary", () => {
    const summary = renderSummary(
      [
        message("user", "Hi, what's my best task?"),
        message("assistant", "Ranked your tasks."),
        message("system", SYSTEM_CATALOG),
        message("system", "The Code Mode tool catalog has changed again."),
        message("user", "How does compaction work?"),
        message("assistant", "Jev decides which calls stay verbatim."),
      ],
      collectCalls([], 6),
      new Map(),
      300,
    )
    expect(summary).toContain("[user]\nHi, what's my best task?")
    expect(summary).toContain("Jev decides which calls stay verbatim.")
    expect(summary).not.toContain("Code Mode")
    expect(summary).not.toContain("Available tools")
    expect(summary).not.toContain("hanged again")
  })

  test("system rows sit inline without shifting the replay around them", () => {
    const summary = renderSummary(
      [
        message("user", "first question"),
        message("system", SYSTEM_CATALOG),
        message("assistant", "first answer"),
      ],
      collectCalls([], 6),
      new Map(),
      300,
    )
    expect(summary.startsWith("Prior conversation, kept verbatim")).toBe(true)
    expect(summary).toContain("[user]\nfirst question")
    expect(summary).toContain("[assistant]\nfirst answer")
    expect(summary).toMatch(/\[user\]|\[assistant\]/)
    expect(summary.endsWith("first answer")).toBe(true)
  })
})

describe("collectCalls", () => {
  test("tool calls inside system messages are not picked up as compaction candidates", () => {
    const messages: any[] = [
      message("user", "please summarize"),
      {
        role: "system",
        content: [
          { type: "text", text: SYSTEM_CATALOG },
          { type: "tool-call", toolCallId: "call_1", toolName: "execute", input: {} },
          { type: "tool-result", toolCallId: "call_1", result: { type: "text", value: "catalog" } },
        ],
      },
      message("assistant", "done"),
    ]
    const calls = collectCalls(messages, 6)
    expect(calls.map((call) => call.callMsg)).not.toContain(1)
    expect(calls).toHaveLength(0)
  })
})
