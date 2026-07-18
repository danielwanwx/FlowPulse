import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SIGNAL_FILES = {
  traces: "traces.jsonl",
  metrics: "metrics.jsonl",
  logs: "logs.jsonl"
};
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 500;

export class LiveSource {
  constructor({ directory, now = () => Date.now(), freshnessMs = 30_000 } = {}) {
    this.directory = directory;
    this.now = now;
    this.freshnessMs = freshnessMs;
  }

  async project() {
    const signals = {};
    const errors = [];
    let newest = 0;
    let filesPresent = 0;

    for (const [signal, file] of Object.entries(SIGNAL_FILES)) {
      const path = join(this.directory, file);
      try {
        const info = await stat(path);
        filesPresent += 1;
        newest = Math.max(newest, info.mtimeMs);
        signals[signal] = await readSignal(path, signal, this.directory);
      } catch (error) {
        if (error.code !== "ENOENT") errors.push({ signal, message: error.message });
        signals[signal] = [];
      }
    }

    const records = Object.values(signals).flat();
    const topology = topologyFrom(signals);
    const status = filesPresent === 0
      ? "disconnected"
      : records.length === 0
        ? "connecting"
        : this.now() - newest <= this.freshnessMs ? "live" : "stale";

    return {
      kind: "otlp-jsonl",
      status,
      label: statusLabel(status),
      authoritative: records.length > 0,
      directory: this.directory,
      last_observed_at: newest ? new Date(newest).toISOString() : null,
      freshness_ms: newest ? Math.max(0, this.now() - newest) : null,
      counts: Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, value.length])),
      topology,
      evidence: records,
      errors
    };
  }
}

async function readSignal(path, signal, root) {
  const info = await stat(path);
  const start = Math.max(0, info.size - MAX_BYTES);
  const bytes = Buffer.alloc(info.size - start);
  const handle = await open(path, "r");
  try {
    await handle.read(bytes, 0, bytes.length, start);
  } finally {
    await handle.close();
  }
  const text = bytes.toString("utf8");
  let cursor = start;
  const entries = text.split(/(?<=\n)/).map((chunk) => {
    const size = Buffer.byteLength(chunk);
    const entry = { line: chunk.replace(/\r?\n$/, ""), start: cursor, end: cursor + size };
    cursor += size;
    return entry;
  }).slice(start ? 1 : 0).filter((entry) => entry.line).slice(-MAX_RECORDS);
  const records = [];
  for (let index = 0; index < entries.length; index += 1) {
    try {
      const payload = JSON.parse(entries[index].line);
      const digest = createHash("sha256").update(`${signal}:${entries[index].line}`).digest("hex");
      records.push({
        id: `live-${signal.slice(0, 3)}-${digest.slice(0, 12)}`,
        signal,
        kind: signal === "traces" ? "trace" : signal === "metrics" ? "metric" : "log",
        title: `${signal.slice(0, -1)} capture`,
        fact: summarize(payload, signal),
        entity: servicesIn(payload)[0] || "telemetry-source",
        source: "OpenTelemetry Collector file exporter",
        hash: digest,
        at: observedAt(payload) || info.mtime.toISOString(),
        value: { services: servicesIn(payload), raw_sha256: digest },
        captured_at: info.mtime.toISOString(),
        provenance: {
          file: relative(root, path),
          line: start ? null : index + 1,
          byte_start: entries[index].start,
          byte_end: entries[index].end,
          sha256: digest,
          immutable_capture: true
        },
        payload
      });
    } catch {
      // A collector can be writing the final line while it is read; the next projection retries it.
    }
  }
  return records;
}

function topologyFrom(signals = {}) {
  const nodes = new Map();
  const spans = [];
  for (const record of Object.values(signals).flat()) {
    for (const service of servicesIn(record.payload)) {
      nodes.set(service, { id: service, label: labelFor(service), kind: kindFor(service), observed: true, signals: [] });
    }
    for (const service of servicesIn(record.payload)) {
      const node = nodes.get(service);
      if (!node.signals.includes(record.signal)) node.signals.push(record.signal);
    }
  }
  for (const record of signals.traces || []) {
    for (const resourceSpans of record.payload.resourceSpans || []) {
      const service = attributeValue(resourceSpans.resource?.attributes, "service.name") || "unknown-service";
      for (const scope of resourceSpans.scopeSpans || []) {
        for (const span of scope.spans || []) spans.push({ ...span, service });
      }
    }
  }
  const bySpan = new Map(spans.map((span) => [span.spanId, span]));
  const edges = new Map();
  for (const span of spans) {
    const parent = bySpan.get(span.parentSpanId);
    if (!parent || parent.service === span.service) continue;
    const id = `${parent.service}->${span.service}`;
    edges.set(id, { id, from: parent.service, to: span.service, label: span.name || "observed call", observed: true });
  }
  return { nodes: [...nodes.values()].map((node) => ({ ...node, signals: node.signals.sort() })).sort(byId), edges: [...edges.values()].sort(byId) };
}

function servicesIn(payload) {
  const services = [];
  for (const key of ["resourceSpans", "resourceMetrics", "resourceLogs"]) {
    for (const resourceItem of payload[key] || []) {
      const service = attributeValue(resourceItem.resource?.attributes, "service.name");
      if (service && !services.includes(service)) services.push(service);
    }
  }
  return services.sort();
}

function summarize(payload, signal) {
  const services = servicesIn(payload);
  return `Observed ${signal} from ${services.length ? services.join(", ") : "an OTLP resource"}.`;
}

function observedAt(payload) {
  let newest = 0n;
  visit(payload, (key, value) => {
    if ((key === "timeUnixNano" || key === "endTimeUnixNano") && /^\d+$/.test(String(value))) {
      newest = BigInt(value) > newest ? BigInt(value) : newest;
    }
  });
  return newest ? new Date(Number(newest / 1_000_000n)).toISOString() : null;
}

function visit(value, callback) {
  if (Array.isArray(value)) return value.forEach((item) => visit(item, callback));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    visit(child, callback);
  }
}

function attributeValue(attributes = [], key) {
  const value = attributes.find((item) => item.key === key)?.value;
  if (!value) return null;
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? null;
}

function kindFor(service) {
  if (service.includes("frontend")) return "client";
  if (service.includes("payment")) return "api";
  if (service.includes("kafka")) return "stream";
  if (service.includes("accounting") || service.includes("fraud")) return "worker";
  if (service.includes("postgres") || service.includes("database")) return "database";
  return "service";
}

function labelFor(service) {
  return service.split(/[-_]/).map((word) => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
}

function statusLabel(status) {
  return ({ disconnected: "Disconnected", connecting: "Connecting", live: "Live OTLP", stale: "Stale OTLP" })[status];
}

function byId(a, b) { return a.id.localeCompare(b.id); }
