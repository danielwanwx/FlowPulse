// This is the only P0 autonomy policy input.  It is checked in, versioned,
// deeply frozen, and is intentionally not accepted from routes, models, or UI.
const LOW_CONTRACT = {
  repair_id: "repair-low-cache-flush-v1",
  action: "simulate a bounded edge-cache flush",
  command_id: "flowpulse.simulate-cache-flush",
  target: "edge-cache",
  expected_before: "stale",
  expected_after: "fresh"
};

const CHECKOUT_CONTRACT = {
  repair_id: "repair-payment-reachable-v1",
  action: "restore known-good paymentUnreachable flag and recreate checkout",
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
      execution_mode: "captured_simulation"
    },
    {
      id: "captured-medium-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-medium-cache-v1", command_id: "flowpulse.propose-medium-cache-action" },
      impact: { level: "medium" },
      action: { ...baseAction, risk: "medium" },
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      execution_mode: "captured_simulation"
    },
    {
      id: "captured-high-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-high-cache-v1", command_id: "flowpulse.propose-high-cache-action" },
      impact: { level: "high" },
      action: { ...baseAction, risk: "high" },
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      execution_mode: "captured_simulation"
    },
    {
      id: "captured-sev1-maintenance",
      environment: "captured_demo",
      contract: { ...LOW_CONTRACT, repair_id: "repair-sev1-cache-v1", command_id: "flowpulse.propose-sev1-cache-action" },
      impact: { level: "sev1" },
      action: { ...baseAction, risk: "sev1" },
      notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
      execution_mode: "captured_simulation"
    },
    {
      id: "checkout-payment",
      environment: "local_development",
      contract: CHECKOUT_CONTRACT,
      impact: { level: "medium" },
      action: { ...baseAction, risk: "medium" },
      notification: { status: "recorded_local", delivery_mode: "local_ledger", target_refs: ["owner-demo"] },
      execution_mode: "real_local_development"
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

// Validation is exported for deterministic artifact tests only. It accepts no
// runtime dependencies and cannot issue a decision, receipt, or authority.
export function validateAutonomyPolicyArtifact(value) {
  assertExactObject(value, ["schema_version", "version", "registry", "intents"], "artifact");
  if (value.schema_version !== "flowpulse.autonomy-artifacts.v1" || !text(value.version, 40)) fail("artifact");
  assertExactObject(value.registry, ["schema_version", "envelopes"], "registry");
  if (value.registry.schema_version !== "flowpulse-preauthorization-registry.v1" || !Array.isArray(value.registry.envelopes)) fail("registry");
  for (const envelope of value.registry.envelopes) validateEnvelope(envelope);
  if (!Array.isArray(value.intents) || value.intents.length === 0) fail("intents");
  const ids = new Set();
  for (const intent of value.intents) {
    validateIntent(intent);
    if (ids.has(intent.id)) fail("intent.id");
    ids.add(intent.id);
  }
  return true;
}

function validateEnvelope(value) {
  assertExactObject(value, ["schema_version", "id", "policy_version", "policy_sha256", "status", "issued_by", "issued_at", "expires_at", "environment", "action_contract", "limits", "required_verification_check_ids", "notification_targets"], "envelope");
  if (value.schema_version !== "flowpulse-preauthorization.v1" || value.status !== "active" || !text(value.id, 120) || !text(value.policy_version, 40) || !hash(value.policy_sha256) || !text(value.issued_by, 120) || !timestamp(value.issued_at) || !timestamp(value.expires_at) || Date.parse(value.issued_at) >= Date.parse(value.expires_at) || value.environment !== "captured_demo") fail("envelope");
  validateContract(value.action_contract);
  assertExactObject(value.limits, ["max_components", "max_attempts", "require_idempotency", "require_rollback", "require_fresh_verification", "require_notification_receipt"], "limits");
  if (!positive(value.limits.max_components) || !positive(value.limits.max_attempts) || !["require_idempotency", "require_rollback", "require_fresh_verification", "require_notification_receipt"].every((key) => value.limits[key] === true)) fail("limits");
  stringList(value.required_verification_check_ids, 8, 120, "required_verification_check_ids");
  stringList(value.notification_targets, 8, 120, "notification_targets");
}

function validateIntent(value) {
  assertExactObject(value, ["id", "environment", "contract", "impact", "action", "notification", "execution_mode"], "intent");
  if (!text(value.id, 120) || !["captured_demo", "local_development"].includes(value.environment) || !["captured_simulation", "real_local_development"].includes(value.execution_mode)) fail("intent");
  if ((value.environment === "captured_demo") !== (value.execution_mode === "captured_simulation")) fail("intent.truth");
  validateContract(value.contract);
  assertExactObject(value.impact, ["level"], "impact");
  if (!["low", "medium", "high", "sev1"].includes(value.impact.level)) fail("impact.level");
  assertExactObject(value.action, ["risk", "reversible", "idempotent", "blast_radius_components", "rollback_ready", "verification_ready", "attempt_count"], "action");
  if (value.action.risk !== value.impact.level || value.action.reversible !== true || value.action.idempotent !== true || value.action.rollback_ready !== true || value.action.verification_ready !== true || !positive(value.action.blast_radius_components) || !positive(value.action.attempt_count)) fail("action");
  assertExactObject(value.notification, ["status", "delivery_mode", "target_refs"], "notification");
  const expectedDeliveryMode = value.execution_mode === "captured_simulation" ? "captured_simulation" : "local_ledger";
  if (value.notification.status !== "recorded_local" || value.notification.delivery_mode !== expectedDeliveryMode) fail("notification");
  stringList(value.notification.target_refs, 8, 120, "notification.target_refs");
}

function validateContract(value) {
  assertExactObject(value, ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"], "contract");
  for (const key of ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"]) if (!text(value[key], 240)) fail(`contract.${key}`);
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(label);
}
function stringList(value, maximum, bytes, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || new Set(value).size !== value.length || value.some((item) => !text(item, bytes))) fail(label);
}
function text(value, bytes) { return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= bytes; }
function hash(value) { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function positive(value) { return Number.isInteger(value) && value > 0 && value <= 32; }
function fail(field) { throw new Error(`Invalid checked-in autonomy artifact: ${field}`); }
