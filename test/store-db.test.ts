// Store-db channel tests: direct read-only reads of the CLI's db-backed
// credential store (src/store-db.ts). Synthetic sqlite fixtures through the
// real reader - no network, no subprocess, no secrets.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { extractStoredCredential } from "../src/logic"
import { readStoreDbCredential, storeDbCandidates } from "../src/store-db"

const FUTURE = Date.now() + 90 * 24 * 3600 * 1000
const PAST = Date.now() - 24 * 3600 * 1000

const OAUTH_BLOB = JSON.stringify({
  type: "oauth",
  methodID: "device",
  access: "st_test_access_0123456789abcdef",
  refresh: "rt_test_refresh_token_placeholder",
  expires: FUTURE,
  metadata: { server: "https://opencode.ai/console" },
})

const KEY_BLOB = JSON.stringify({ type: "key", key: "sk_test_key_entry_0123456789" })

function seedDb(seed: (db: InstanceType<typeof Database>) => void, table = "auth_credentials"): string {
  const path = join(mkdtempSync(join(tmpdir(), "jev-storedb-")), "store.db")
  const db = new Database(path)
  db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, integrationID TEXT, active INTEGER, value TEXT)`)
  seed(db)
  db.close()
  return path
}

describe("extractStoredCredential", () => {
  test("the export-entry shape with a string value blob", () => {
    expect(
      extractStoredCredential(
        {
          id: "cred_o",
          integrationID: "opencode",
          active: 1,
          value: OAUTH_BLOB,
        },
        "opencode",
      ),
    ).toEqual({ type: "oauth", material: "st_test_access_0123456789abcdef" })
  })

  test("flat row shapes carry the material directly", () => {
    expect(
      extractStoredCredential(
        {
          integration: "opencode-go",
          type: "oauth",
          access: "st_flat_row_access_0123456789",
        },
        "opencode-go",
      ),
    ).toEqual({ type: "oauth", material: "st_flat_row_access_0123456789" })
  })

  test("the oauth session wins over a plain key entry under one anchor", () => {
    const row = {
      integrationID: "opencode",
      active: 1,
      first: KEY_BLOB,
      second: OAUTH_BLOB,
    }
    expect(extractStoredCredential(row, "opencode")?.type).toBe("oauth")
  })

  test("a stale-dated oauth entry is rejected, the key entry still serves", () => {
    const staleOauth = JSON.stringify({ type: "oauth", access: "st_stale_access_0123456789", expires: PAST })
    expect(extractStoredCredential({ integrationID: "opencode", value: staleOauth }, "opencode")).toBeUndefined()
    expect(
      extractStoredCredential(
        { integrationID: "opencode", first: staleOauth, second: KEY_BLOB },
        "opencode",
      ),
    ).toEqual({ type: "key", material: "sk_test_key_entry_0123456789" })
  })

  test("a foreign integration, inactive entries and junk shapes yield undefined, never a throw", () => {
    expect(extractStoredCredential({ integrationID: "munito", value: OAUTH_BLOB }, "opencode")).toBeUndefined()
    expect(extractStoredCredential({ integrationID: "opencode", active: 0, value: OAUTH_BLOB }, "opencode")).toBeUndefined()
    expect(extractStoredCredential({ integrationID: "opencode", value: "{not json" }, "opencode")).toBeUndefined()
    expect(extractStoredCredential("junk", "opencode")).toBeUndefined()
    expect(extractStoredCredential(null, "opencode")).toBeUndefined()
    expect(extractStoredCredential({ integrationID: "opencode", value: 42 }, "opencode")).toBeUndefined()
  })

  test("unrelated secrets-shaped content without the id tie is ignored", () => {
    // a key-shaped node with no integration tie anywhere nearby
    expect(
      extractStoredCredential({ config: { type: "key", key: "sk_detached_key_0123456789" } }, "opencode"),
    ).toBeUndefined()
  })
})

describe("readStoreDbCredential", () => {
  test("reads the export-entry rows out of an auth-shaped table", () => {
    const path = seedDb((db) => {
      const insert = db.query("INSERT INTO auth_credentials (id, integrationID, active, value) VALUES (?, ?, ?, ?)")
      insert.run("cred_o", "opencode", 1, OAUTH_BLOB)
    })
    try {
      expect(readStoreDbCredential(path, "opencode")).toEqual({
        type: "oauth",
        material: "st_test_access_0123456789abcdef",
      })
    } finally {
      rmSync(path)
    }
  })

  test("prefers the live session over a stored key entry", () => {
    const path = seedDb((db) => {
      const insert = db.query("INSERT INTO auth_credentials (id, integrationID, active, value) VALUES (?, ?, ?, ?)")
      insert.run("cred_k", "opencode", 1, KEY_BLOB)
      insert.run("cred_o", "opencode", 1, OAUTH_BLOB)
    })
    try {
      expect(readStoreDbCredential(path, "opencode")?.type).toBe("oauth")
    } finally {
      rmSync(path)
    }
  })

  test("falls through a stale oauth entry to the key entry", () => {
    const path = seedDb((db) => {
      const insert = db.query("INSERT INTO auth_credentials (id, integrationID, active, value) VALUES (?, ?, ?, ?)")
      insert.run("cred_s", "opencode", 1, JSON.stringify({ type: "oauth", access: "st_stale_access_0123456789", expires: PAST }))
      insert.run("cred_k", "opencode", 1, KEY_BLOB)
    })
    try {
      expect(readStoreDbCredential(path, "opencode")).toEqual({
        type: "key",
        material: "sk_test_key_entry_0123456789",
      })
    } finally {
      rmSync(path)
    }
  })

  test("content tables are entered only after the auth-shaped ones come up empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-storedb-"))
    const path = join(dir, "store.db")
    const db = new Database(path)
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT)")
    db.query("INSERT INTO sessions (id, body) VALUES (?, ?)").run(
      "s1",
      JSON.stringify({ integrationID: "munito", value: KEY_BLOB }),
    )
    db.query("INSERT INTO sessions (id, body) VALUES (?, ?)").run(
      "s2",
      JSON.stringify({ integrationID: "opencode", active: 1, value: OAUTH_BLOB }),
    )
    db.close()
    // auth-shaped tables first, even when a session row could ALSO serve
    const withAuth = seedDb((db2) => {
      db2.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT)")
      db2.query("INSERT INTO sessions (id, body) VALUES (?, ?)").run(
        "s3",
        JSON.stringify({ integrationID: "opencode", active: 1, value: KEY_BLOB }),
      )
      const insert = db2.query("INSERT INTO auth_credentials (id, integrationID, active, value) VALUES (?, ?, ?, ?)")
      insert.run("cred_o", "opencode", 1, OAUTH_BLOB)
    })
    try {
      expect(readStoreDbCredential(withAuth, "opencode")?.type).toBe("oauth")
      // no auth table at all: the content-table scan still reaches the row
      expect(readStoreDbCredential(path, "opencode")).toEqual({
        type: "oauth",
        material: "st_test_access_0123456789abcdef",
      })
      rmSync(path)
    } finally {
      rmSync(withAuth)
    }
  })

  test("malformed rows and unreadable files degrade to undefined, never a throw", () => {
    const path = seedDb((db) => {
      const insert = db.query("INSERT INTO auth_credentials (id, integrationID, active, value) VALUES (?, ?, ?, ?)")
      insert.run("cred_1", "opencode", 1, "{unterminated json")
      insert.run("cred_2", "opencode", 1, "")
      insert.run("cred_3", "opencode", null as unknown as number, null as unknown as string)
    })
    try {
      expect(readStoreDbCredential(path, "opencode")).toBeUndefined()
    } finally {
      rmSync(path)
    }
    expect(readStoreDbCredential(join(tmpdir(), "jev-storedb-does-not-exist.db"), "opencode")).toBeUndefined()
  })
})

describe("storeDbCandidates", () => {
  test("newest first, both store file names, absent dirs skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-storedb-cands-"))
    const fresh = join(dir, "opencode.db")
    const stale = join(dir, "opencode-stable.db")
    for (const path of [fresh, stale]) new Database(path).close()
    // stable gets the newer mtime: it must come first despite the push order
    utimesSync(stale, new Date(1000), new Date(2000))
    utimesSync(fresh, new Date(1000), new Date(1000))
    try {
      expect(storeDbCandidates([dir])).toEqual([stale, fresh])
      expect(storeDbCandidates([join(dir, "missing")])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
