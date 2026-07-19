// This is the only P0 autonomy policy input.  It is checked in, versioned,
// deeply frozen, and is intentionally not accepted from routes, models, or UI.
const LOW_CONTRACT = {
  repair_id: "repair-low-cache-flush-v1",
  command_id: "flowpulse.simulate-cache-flush",
  target: "edge-cache",
  expected_before: "stale",
  expected_after: "fresh"
};

const CHECKOUT_CONTRACT = {
  repair_id: "repair-payment-reachable-v1",
  command_id: "astronomy.restore-payment-and-recreate-checkout",
  target: "checkout",
  expected_before: "paymentUnreachable=on",
  expected_after: "paymentUnreachable=off"
};

const baseAction = {
  risk: "low",
  reversible: true,
  idempotent: true,
  blast_radius_components: 1,
  rollback_ready: true,
  verification_ready: true,
  attempt_count: 1
};

const artifact = {
  schema_version: "flowpulse.autonomy-artifacts.v1",
  version: "2026-07-18",
  registry: {
    schema_version: "flowpulse-preauthorization-registry.v1",
    envelopes: [{
      schema_version: "flowpulse-preauthorization.v1",
      id: "preauth-edge-cache-v1",
      policy_version: "2026-07-18",
      policy_sha256: `sha256:${"c".repeat(64)}`,
      status: "active",
      issued_by: "authorized-owner",
      issued_at: "2025-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      environment: "captured_demo",
      action_contract: LOW_CONTRACT,
      limits: {
        max_components: 1,
        max_attempts: 1,
        require_idempotency: true,
        require_rollback: true,
        require_fresh_verification: true,
        require_notification_receipt: true
      },
      required_verification_check_ids: ["fresh-cache-read"],
      notification_targets: ["owner-demo"]
    }]
  },
  intents: [
    {
      id: "captured-cache-flush",
      environment: "captured_demo",
      contract: LOW_CONTRACT,
      impact: { level: "low" },
      action: baseAction,
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      truth_mode: "captured_simulation"
    },
    {
      id: "captured-medium-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-medium-cache-v1", command_id: "flowpulse.propose-medium-cache-action" },
      impact: { level: "medium" },
      action: baseAction,
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      truth_mode: "captured_simulation"
    },
    {
      id: "captured-high-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-high-cache-v1", command_id: "flowpulse.propose-high-cache-action" },
      impact: { level: "high" },
      action: { ...baseAction, risk: "high" },
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      truth_mode: "captured_simulation"
    },
    {
      id: "captured-sev1-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-sev1-cache-v1", command_id: "flowpulse.propose-sev1-cache-action" },
      impact: { level: "sev1" },
      action: { ...baseAction, risk: "high" },
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      truth_mode: "captured_simulation"
    },
    {
      id: "checkout-payment",
      environment: "local_development",
      contract: CHECKOUT_CONTRACT,
      impact: { level: "medium" },
      action: baseAction,
      notification: { status: "recorded_local", delivery_mode: "local_ledger", target_refs: ["owner-demo"] },
      truth_mode: "captured_simulation"
    }
  ]
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const AUTONOMY_POLICY_ARTIFACT = deepFreeze(artifact);
