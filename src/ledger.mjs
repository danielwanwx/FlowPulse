import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const sqlValue = (value) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

export class Ledger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.exec(`
      PRAGMA busy_timeout=3000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        run_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        offset_ms INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
        parent_id TEXT,
        correlation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id, sequence);
      CREATE TRIGGER IF NOT EXISTS events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'FlowPulse ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'FlowPulse ledger is append-only'); END;
    `);
  }

  exec(sql) {
    const result = spawnSync("sqlite3", ["-batch", this.path], { input: sql, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `sqlite3 exited with ${result.status}`);
    return result.stdout;
  }

  query(sql) {
    const output = execFileSync("sqlite3", ["-batch", "-json", this.path, sql], { encoding: "utf8" }).trim();
    return output ? JSON.parse(output) : [];
  }

  append({
    id = `evt-${randomUUID()}`,
    runId,
    incidentId,
    offsetMs = 0,
    type,
    actor,
    payload = {},
    evidenceRefs = [],
    parentId = null,
    correlationId = `corr-${randomUUID()}`,
    recordedAt = new Date().toISOString()
  }) {
    return this.#insert({
      id, runId, incidentId, offsetMs, type, actor, payload, evidenceRefs, parentId, correlationId, recordedAt
    }).event;
  }

  appendIfAbsent({
    id,
    runId,
    incidentId,
    offsetMs = 0,
    type,
    actor,
    payload = {},
    evidenceRefs = [],
    parentId = null,
    correlationId,
    recordedAt = new Date().toISOString()
  }) {
    if (!id) throw new Error("appendIfAbsent requires a deterministic event id");
    return this.#insert({
      id, runId, incidentId, offsetMs, type, actor, payload, evidenceRefs, parentId, correlationId, recordedAt
    }, true);
  }

  #insert({
    id,
    runId,
    incidentId,
    offsetMs = 0,
    type,
    actor,
    payload = {},
    evidenceRefs = [],
    parentId = null,
    correlationId = `corr-${randomUUID()}`,
    recordedAt = new Date().toISOString()
  }, ignore = false) {
    if (!runId || !incidentId || !type || !actor) throw new Error("Incomplete ledger event");
    const values = [
      id, runId, incidentId, recordedAt, Number(offsetMs), type, actor,
      JSON.stringify(payload), JSON.stringify(evidenceRefs), parentId, correlationId
    ].map(sqlValue).join(",");
    const output = this.exec(`PRAGMA busy_timeout=3000;
      ${ignore ? "INSERT OR IGNORE" : "INSERT"} INTO events
      (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (${values});
      SELECT changes() AS inserted;`);
    return { event: this.get(id), inserted: output.trim().split(/\s+/).at(-1) === "1" };
  }

  get(id) {
    return decode(this.query(`SELECT * FROM events WHERE id=${sqlValue(id)} LIMIT 1;`)[0]);
  }

  list(runId) {
    return this.query(`SELECT * FROM events WHERE run_id=${sqlValue(runId)} ORDER BY sequence;`).map(decode);
  }

  latestRun(incidentId) {
    const row = this.query(`SELECT run_id FROM events WHERE incident_id=${sqlValue(incidentId)} AND type='run.started' ORDER BY sequence DESC LIMIT 1;`)[0];
    return row?.run_id ?? null;
  }
}

function decode(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return {
    sequence: row.sequence,
    id: row.id,
    run_id: row.run_id,
    incident_id: row.incident_id,
    recorded_at: row.recorded_at,
    offset_ms: row.offset_ms,
    type: row.type,
    actor: row.actor,
    payload,
    payload_sha256: sha256Canonical(payload),
    evidence_refs: JSON.parse(row.evidence_refs_json),
    parent_id: row.parent_id,
    correlation_id: row.correlation_id
  };
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
