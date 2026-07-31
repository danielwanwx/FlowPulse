import { latestBySequence, projectIncidentClock } from "./control-plane-topology-layout.mjs";

// These helpers deliberately accept only values already admitted by the V2
// browser contract. They do not fill gaps, interpolate metrics, or infer a
// root cause. Every point in the chart maps to one server-owned signal.
export function incidentWorkspaceSnapshot(projection, now = Date.now()) {
  const signal = latestBySequence(projection?.realtime_signals || []);
  const clock = projection?.incident_clock ? projectIncidentClock(projection.incident_clock, now) : null;
  const signals = [...(projection?.realtime_signals || [])]
    .sort((left, right) => left.sequence - right.sequence);
  return {
    signal,
    clock,
    signals,
    chart: metricChart(signals),
    affectedNodes: (projection?.graph?.nodes || []).filter((node) => projection?.impacted_path?.includes(node.component_id)),
    activities: [...(projection?.agent_workspace?.activities || [])]
      .sort((left, right) => right.sequence - left.sequence),
    citations: [...(projection?.agent_workspace?.citations || [])]
      .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))
  };
}

export function metricChart(signals, width = 560, height = 156) {
  const unit = signalUnit([...signals].reverse().find((signal) => numericSignalValue(signal.display_value) !== null)?.display_value);
  const values = signals.map((signal) => ({
    sequence: signal.sequence,
    observed_at: signal.observed_at,
    value: numericSignalValue(signal.display_value)
  })).filter((point) => point.value !== null);
  if (!values.length) return { points: [], min: null, max: null, unit };
  const min = Math.min(...values.map((point) => point.value));
  const max = Math.max(...values.map((point) => point.value));
  const span = Math.max(max - min, Math.max(Math.abs(max) * 0.12, 0.1));
  const lower = min - span * 0.16;
  const upper = max + span * 0.16;
  const denominator = Math.max(values.length - 1, 1);
  return {
    min,
    max,
    unit,
    points: values.map((point, index) => ({
      ...point,
      x: Number((index / denominator * width).toFixed(2)),
      y: Number((height - ((point.value - lower) / (upper - lower) * height)).toFixed(2))
    }))
  };
}

export function numericSignalValue(value) {
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[,%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function signalUnit(value) {
  return typeof value === "string" && value.includes("%") ? "%" : "";
}

export function formatIncidentDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${remainder}s`;
}

export function conciseTimestamp(value) {
  const parsed = Date.parse(value || "");
  if (Number.isNaN(parsed)) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short"
  }).format(new Date(parsed));
}
