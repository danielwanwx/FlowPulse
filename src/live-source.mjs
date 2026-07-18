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
        value: { services: servicesIn(payload), raw_sha256: digest, ...signalFacts(payload, signal) },
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
  const service = services[0] || "an OTLP resource";
  const facts = signalFacts(payload, signal);
  if (facts.trace) {
    const status = facts.trace.status || "status missing";
    const target = facts.trace.peer_target ? ` to ${facts.trace.peer_target}` : "";
    const error = facts.trace.error ? `: ${facts.trace.error}` : "";
    return `${service} span ${facts.trace.operation || "operation missing"}${target} reported ${status}${error}.`;
  }
  if (facts.log) return `${service} ${facts.log.severity || "log"}: ${facts.log.message || "message redacted or missing"}.`;
  if (facts.metric) return `${service} metric ${facts.metric.name || "name missing"}=${facts.metric.value ?? "value missing"}${facts.metric.unit ? ` ${facts.metric.unit}` : ""}.`;
  return `Observed ${signal} from ${service}.`;
}

function signalFacts(payload, signal) {
  if (signal === "traces") return { trace: traceFact(payload) };
  if (signal === "logs") return { log: logFact(payload) };
  if (signal === "metrics") return { metric: metricFact(payload) };
  return {};
}

function traceFact(payload) {
  const span = firstSpan(payload);
  if (!span) return { operation: null, peer_target: null, status: "missing", error: null, observed_at: observedAt(payload) };
  const target = targetFor(span);
  const status = span.status?.code === 2 ? "error" : span.status?.code === 1 ? "ok" : span.status?.code === 0 ? "unset" : "missing";
  const exception = exceptionFor(span);
  return {
    operation: bounded(span.name, 160),
    peer_target: bounded(target, 160),
    status,
    error: bounded(span.status?.message || exception, 240),
    observed_at: observedAt(payload)
  };
}

function logFact(payload) {
  for (const resource of payload.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      const log = scope.logRecords?.[0];
      if (!log) continue;
      return {
        severity: bounded(log.severityText || log.severityNumber ? String(log.severityText || log.severityNumber) : null, 40),
        message: bounded(anyValue(log.body), 240),
        trace_id: bounded(log.traceId, 64),
        span_id: bounded(log.spanId, 32),
        observed_at: observedAt(payload)
      };
    }
  }
  return { severity: null, message: null, trace_id: null, span_id: null, observed_at: observedAt(payload) };
}

function metricFact(payload) {
  for (const resource of payload.resourceMetrics || []) {
    for (const scope of resource.scopeMetrics || []) {
      const metric = scope.metrics?.[0];
      if (!metric) continue;
      const aggregation = ["gauge", "sum", "histogram", "summary", "exponentialHistogram"].find((key) => metric[key]);
      const point = aggregation ? metric[aggregation]?.dataPoints?.[0] : null;
      return {
        name: bounded(metric.name, 160),
        value: numericValue(point),
        unit: bounded(metric.unit, 40),
        aggregation: aggregation || null,
        observed_at: observedAt(payload)
      };
    }
  }
  return { name: null, value: null, unit: null, aggregation: null, observed_at: observedAt(payload) };
}

function firstSpan(payload) {
  for (const resource of payload.resourceSpans || []) for (const scope of resource.scopeSpans || []) if (scope.spans?.[0]) return scope.spans[0];
  return null;
}

function targetFor(span) {
  const attributes = span.attributes || [];
  const host = attributeValue(attributes, "server.address") || attributeValue(attributes, "net.peer.name") || attributeValue(attributes, "peer.service") || attributeValue(attributes, "http.url");
  const port = attributeValue(attributes, "server.port") || attributeValue(attributes, "net.peer.port");
  return host && port && !String(host).includes(":") ? `${host}:${port}` : host;
}

function exceptionFor(span) {
  for (const event of span.events || []) {
    if (event.name !== "exception") continue;
    return attributeValue(event.attributes, "exception.message") || attributeValue(event.attributes, "exception.type") || null;
  }
  return null;
}

function anyValue(value) {
  if (!value || typeof value !== "object") return value == null ? null : String(value);
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? null;
}

function numericValue(point) {
  if (!point) return null;
  const value = point.asDouble ?? point.asInt ?? point.sum;
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function bounded(value, length) {
  if (value == null || value === "") return null;
  return String(value).replace(/[\r\n\t]+/g, " ").slice(0, length);
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
