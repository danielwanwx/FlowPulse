import test from "node:test";
import assert from "node:assert/strict";
import { formatIncidentDuration, incidentWorkspaceSnapshot, metricChart } from "../public/incident-workspace.mjs";

const signal = (sequence, display_value, observed_at) => ({ sequence, display_value, observed_at });

test("metric chart contains only server signal samples", () => {
  const chart = metricChart([
    signal(7, "8.4%", "2026-07-30T21:58:00.000Z"),
    signal(8, "9.1%", "2026-07-30T21:58:02.000Z"),
    signal(9, "unavailable", "2026-07-30T21:58:04.000Z")
  ]);
  assert.equal(chart.points.length, 2);
  assert.deepEqual(chart.points.map((point) => point.sequence), [7, 8]);
  assert.equal(chart.unit, "%");
});

test("incident duration is projected only through the bounded clock helper", () => {
  const projection = {
    realtime_signals: [signal(3, "8.4%", "2026-07-30T21:58:00.000Z")],
    incident_clock: {
      state: "RUNNING", freshness: "CURRENT", elapsed_seconds: 20,
      as_of: "2026-07-30T21:58:00.000Z", fresh_until: "2026-07-30T21:58:30.000Z", max_interpolation_seconds: 30
    },
    graph: { nodes: [] }, impacted_path: [], agent_workspace: { activities: [], citations: [] }
  };
  assert.equal(incidentWorkspaceSnapshot(projection, Date.parse("2026-07-30T21:58:10.000Z")).clock.elapsed_seconds, 30);
  assert.equal(incidentWorkspaceSnapshot(projection, Date.parse("2026-07-30T21:59:00.000Z")).clock.elapsed_seconds, 50);
  assert.equal(formatIncidentDuration(3664), "1h 1m");
});
