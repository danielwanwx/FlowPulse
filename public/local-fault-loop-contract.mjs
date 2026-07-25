// This is the browser-safe portion of the local fault-loop backend contract.
// Keeping it in one importable module prevents the Incident UI from accepting
// a more permissive schema than the server emits.
export const LOCAL_FAULT_LOOP_CASE_IDS = Object.freeze([
  "checkout-payment-config",
  "kafka-consumer-pause",
  "database-pool-exhaustion",
  "insufficient-evidence"
]);

export const LOCAL_FAULT_LOOP_EXECUTION_SCOPE = "local_memory_only";

export const LOCAL_FAULT_LOOP_VERIFICATION_CHECK_IDS = Object.freeze([
  "root_condition_removed",
  "direct_symptom_cleared",
  "downstream_lag_converged"
]);

export function validLocalFaultLoopCaseId(value) {
  return typeof value === "string" && LOCAL_FAULT_LOOP_CASE_IDS.includes(value);
}
