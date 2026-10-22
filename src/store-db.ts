// Direct read of the CLI's db-backed credential store .
//
// The V2 CLI keeps the Console login (the OAuth session the CLI refreshes on
// its own 401s) in a sqlite db under the opencode data dir, and
// `opencode auth export` reads it in-process. When the CLI subprocess is
// unavailable the plugin can still read the same credentials directly -
// read-only, schema-tolerant, best effort. This channel keeps jev riding the
// live, rotating Console session in contexts where the subprocess is refused
// and only the stale legacy auth.json key would otherwise serve.
//
// Hygiene: the material is extracted and returned, never logged; failures
// yield undefined and the credential chain simply moves on.

import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { extractStoredCredential } from "./logic"

/** Names that hold transcript/content rows, not live credentials - scanning
 * them risks picking up past token material that tool output once read, and
 * they are entered only after the auth-shaped tables come up empty. */
const CONTENT_TABLE = /session|message|prompt|event|snapshot|blob|part/i
/** Name shapes of tables plausibly holding credentials, scanned first. */
const AUTH_TABLE = /auth|credential|integration|account|config/i

const ROW_LIMIT = 300

/** The db files the CLI uses , newest first. One binary's
 * live db sees the writes - the others are stale installs; mtime puts the
 * live one first. */
export function storeDbCandidates(dataDirs?: string[]): string[] {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const dirs = dataDirs ?? [join(base, "opencode")]
  const files: Array<{ path: string; mtime: number }> = []
  for (const dir of dirs) {
    for (const name of ["opencode-stable.db", "opencode.db"]) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      try {
        files.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        files.push({ path, mtime: 0 })
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.map((file) => file.path)
}

/** Reads the stored credential for an integration straight from the db.
 * Read-only open, bounded scans, never throws, never logs values. An oauth
 * session entry (the CLI keeps it refreshed) is preferred over a plain key
 * entry; oauth entries whose stored expires has passed are treated as stale
 * and skipped - an unusable session deserves the "no credential" chain tail
 * and its actionable remedy, not a guaranteed 401 loop. */
export function readStoreDbCredential(
  path: string,
  integrationID: string,
): { type: "key" | "oauth"; material: string } | undefined {
  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(path, { readonly: true })
  } catch {
    return undefined
  }
  try {
    return readCredentialFrom(db, integrationID)
  } catch {
    return undefined
  } finally {
    try {
      db.close()
    } catch {
      // already closed - nothing to do
    }
  }
}

function readCredentialFrom(
  db: InstanceType<typeof Database>,
  integrationID: string,
): { type: "key" | "oauth"; material: string } | undefined {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 40").all() as Array<{
    name: string
  }>)
    .map((row) => row.name)
    .filter((name) => typeof name === "string" && name.length > 0)
  // Auth-shaped tables first, content tables last; unknown shapes in
  // between. Within one table the structured row scan is order-tolerant.
  const order = [
    ...tables.filter((name) => !CONTENT_TABLE.test(name) && AUTH_TABLE.test(name)),
    ...tables.filter((name) => !CONTENT_TABLE.test(name) && !AUTH_TABLE.test(name)),
    ...tables.filter((name) => CONTENT_TABLE.test(name)),
  ]
  for (const table of order) {
    let rows: unknown[]
    try {
      rows = db.query(`SELECT * FROM "${table.replace(/"/g, "")}" LIMIT ${ROW_LIMIT}`).all()
    } catch {
      continue // unreadable/virtual table - next
    }
    const found: Array<{ type: "key" | "oauth"; material: string }> = []
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue
      try {
        const hit = extractStoredCredential(row, integrationID)
        if (hit) found.push(hit)
      } catch {
        continue // malformed row content - next
      }
    }
    if (found.length > 0) {
      // the cli-refreshed oauth session outranks a plain key entry even
      // when the key row sorts first within this table
      const oauth = found.find((candidate) => candidate.type === "oauth")
      if (oauth) return oauth
      return found[0]
    }
  }
  return undefined
}
