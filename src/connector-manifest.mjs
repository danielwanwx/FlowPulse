import {
  CAPTURE_MODES,
  CONNECTOR_PROJECTION_SCHEMA_VERSION,
  ENTITY_KINDS,
  EVIDENCE_ENVELOPE_LIMITS,
  EVIDENCE_ENVELOPE_SCHEMA_VERSION,
  EVIDENCE_TYPES,
  RELATION_TYPES,
  SOURCE_KINDS,
  canonicalSha256,
  normalizeEvidenceEnvelope
} from "./evidence-envelope.mjs";

export const CONNECTOR_MANIFEST_SCHEMA_VERSION = "flowpulse.connector-manifest.v1";
export const CONNECTOR_RECEIPT_SCHEMA_VERSION = "flowpulse.connector-receipt.v1";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DISPLAY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;

export class ConnectorContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ConnectorContractError";
    this.code = code;
  }
}

export function connectorManifestContract(manifest) {
  if (!plain(manifest)) return null;
  const { display: _display, contract_sha256: _contractSha256, ...contract } = manifest;
  return contract;
}

export function connectorManifestContractSha256(manifest) {
  const contract = connectorManifestContract(manifest);
  return contract ? canonicalSha256(contract) : null;
}

export function validateConnectorManifest(value) {
  const required = ["schema_version", "connector_id", "version", "display", "source_kinds", "entity_kinds", "relation_types", "evidence_types", "capture_modes", "input_contract_versions", "output_contract_versions", "capabilities", "permissions", "scopes", "risk_class", "redaction", "limits", "provenance", "health", "contract_sha256"];
  if (!plain(value) || !exactKeys(value, required) || value.schema_version !== CONNECTOR_MANIFEST_SCHEMA_VERSION || !id(value.connector_id) || !version(value.version) || !display(value.display) || value.contract_sha256 !== connectorManifestContractSha256(value)) fail("connector_manifest_invalid");
  exactEnumList(value.source_kinds, SOURCE_KINDS, "connector_manifest_capability_invalid");
  exactEnumList(value.entity_kinds, ENTITY_KINDS, "connector_manifest_capability_invalid");
  exactEnumList(value.relation_types, RELATION_TYPES, "connector_manifest_capability_invalid");
  exactEnumList(value.evidence_types, EVIDENCE_TYPES, "connector_manifest_capability_invalid");
  exactEnumList(value.capture_modes, CAPTURE_MODES, "connector_manifest_capability_invalid");
  if (!sameArray(value.input_contract_versions, [EVIDENCE_ENVELOPE_SCHEMA_VERSION]) || !sameArray(value.output_contract_versions, [CONNECTOR_PROJECTION_SCHEMA_VERSION])) fail("connector_manifest_contract_version_invalid");
  if (!plain(value.capabilities) || !exactKeys(value.capabilities, ["discover", "topology", "evidence", "action", "verification"]) || value.capabilities.discover !== true || value.capabilities.topology !== true || value.capabilities.evidence !== true || value.capabilities.action !== false || value.capabilities.verification !== false) fail("connector_manifest_capability_invalid");
  if (!plain(value.permissions) || !exactKeys(value.permissions, ["read_only", "network_write", "action", "remediation", "authority"]) || value.permissions.read_only !== true || value.permissions.network_write !== false || value.permissions.action !== false || value.permissions.remediation !== false || value.permissions.authority !== false) fail("connector_manifest_permission_invalid");
  if (!plain(value.scopes) || !exactKeys(value.scopes, ["incident_id", "run_id", "correlation_id"]) || Object.values(value.scopes).some((item) => item !== true) || value.risk_class !== "advisory") fail("connector_manifest_scope_invalid");
  if (!plain(value.redaction) || !exactKeys(value.redaction, ["required", "version", "states"]) || value.redaction.required !== true || value.redaction.version !== "v1" || !sameArray(value.redaction.states, ["redacted", "synthetic"])) fail("connector_manifest_redaction_invalid");
  if (!plain(value.limits) || !exactKeys(value.limits, ["max_envelope_bytes", "max_entities", "max_relations", "max_evidence"]) || !positive(value.limits.max_envelope_bytes, EVIDENCE_ENVELOPE_LIMITS.max_bytes) || !positive(value.limits.max_entities, EVIDENCE_ENVELOPE_LIMITS.max_entities) || !positive(value.limits.max_relations, EVIDENCE_ENVELOPE_LIMITS.max_relations) || !positive(value.limits.max_evidence, EVIDENCE_ENVELOPE_LIMITS.max_evidence)) fail("connector_manifest_limit_invalid");
  if (!plain(value.provenance) || !exactKeys(value.provenance, ["required", "hash_algorithm"]) || value.provenance.required !== true || value.provenance.hash_algorithm !== "sha256") fail("connector_manifest_provenance_invalid");
  if (!plain(value.health) || !exactKeys(value.health, ["accepted", "max_age_ms"]) || !sameArray(value.health.accepted, ["live"]) || !positive(value.health.max_age_ms, 300_000)) fail("connector_manifest_health_invalid");
  return deepFreeze({ ...value, display: { ...value.display }, source_kinds: [...value.source_kinds], entity_kinds: [...value.entity_kinds], relation_types: [...value.relation_types], evidence_types: [...value.evidence_types], capture_modes: [...value.capture_modes], input_contract_versions: [...value.input_contract_versions], output_contract_versions: [...value.output_contract_versions], capabilities: { ...value.capabilities }, permissions: { ...value.permissions }, scopes: { ...value.scopes }, redaction: { ...value.redaction, states: [...value.redaction.states] }, limits: { ...value.limits }, provenance: { ...value.provenance }, health: { ...value.health, accepted: [...value.health.accepted] } });
}

export function connectorPolicy(manifest) {
  const safe = validateConnectorManifest(manifest);
  return deepFreeze({
    connector_id: safe.connector_id,
    version: safe.version,
    manifest_contract_sha256: safe.contract_sha256,
    read_only: true,
    can_mutate: false,
    can_authorize: false,
    can_execute: false,
    discover: true,
    topology: true,
    evidence: true,
    action: false,
    verification: false,
    source_kinds: [...safe.source_kinds],
    capture_modes: [...safe.capture_modes]
  });
}

export function validateConnectorBundle(value) {
  if (!plain(value) || !exactKeys(value, ["manifest", "envelope", "receipt"])) fail("connector_bundle_fields_invalid");
  const manifest = validateConnectorManifest(value.manifest);
  const envelope = normalizeEvidenceEnvelope(value.envelope);
  validateCompatibility(manifest, envelope);
  const receipt = validateConnectorReceipt(value.receipt, manifest, envelope);
  return deepFreeze({
    schema_version: CONNECTOR_PROJECTION_SCHEMA_VERSION,
    connector: { id: manifest.connector_id, version: manifest.version, display: { ...manifest.display } },
    capabilities: connectorPolicy(manifest),
    receipt: { id: receipt.receipt_id, expires_at: receipt.expires_at },
    ...envelope
  });
}

export function validateConnectorReceipt(value, manifest, envelope) {
  const required = ["schema_version", "receipt_id", "connector_id", "connector_version", "manifest_contract_sha256", "envelope_schema_version", "envelope_id", "event_id", "incident_id", "run_id", "correlation_id", "content_sha256", "capture_mode", "source_health", "issued_at", "expires_at"];
  if (!plain(value) || !exactKeys(value, required) || value.schema_version !== CONNECTOR_RECEIPT_SCHEMA_VERSION || !id(value.receipt_id) || !timestamp(value.issued_at) || !timestamp(value.expires_at)) fail("connector_receipt_invalid");
  if (value.connector_id !== manifest.connector_id || value.connector_version !== manifest.version || value.manifest_contract_sha256 !== manifest.contract_sha256 || value.envelope_schema_version !== EVIDENCE_ENVELOPE_SCHEMA_VERSION || value.envelope_id !== envelope.envelope_id || value.event_id !== envelope.event_id || value.incident_id !== envelope.incident_id || value.run_id !== envelope.run_id || value.correlation_id !== envelope.correlation_id || value.content_sha256 !== envelope.provenance.content_sha256 || value.capture_mode !== envelope.source.capture_mode || value.source_health !== envelope.source.source_health) fail("connector_receipt_binding_invalid");
  const observedAt = Date.parse(envelope.observed_at);
  const receivedAt = Date.parse(envelope.received_at);
  const issuedAt = Date.parse(value.issued_at);
  const expiresAt = Date.parse(value.expires_at);
  if (receivedAt - observedAt > manifest.health.max_age_ms || issuedAt < receivedAt || expiresAt < issuedAt || expiresAt - issuedAt > manifest.health.max_age_ms) fail("connector_receipt_freshness_invalid");
  return deepFreeze({ ...value });
}

function validateCompatibility(manifest, envelope) {
  if (!manifest.source_kinds.includes(envelope.source.source_kind) || !manifest.capture_modes.includes(envelope.source.capture_mode) || !manifest.health.accepted.includes(envelope.source.source_health)) fail("connector_source_capability_invalid");
  if (!manifest.redaction.states.includes(envelope.provenance.redaction_state) || envelope.graph.entities.length > manifest.limits.max_entities || envelope.graph.relations.length > manifest.limits.max_relations || envelope.evidence.length > manifest.limits.max_evidence) fail("connector_envelope_limit_invalid");
  if (envelope.graph.entities.some((item) => !manifest.entity_kinds.includes(item.kind)) || envelope.graph.relations.some((item) => !manifest.relation_types.includes(item.type)) || envelope.evidence.some((item) => !manifest.evidence_types.includes(item.type))) fail("connector_declared_capability_invalid");
  if (envelope.provenance.connector_id !== manifest.connector_id || envelope.provenance.connector_version !== manifest.version) fail("connector_provenance_binding_invalid");
}

function exactEnumList(value, allowed, code) {
  if (!Array.isArray(value) || !value.length || value.length > allowed.length || new Set(value).size !== value.length || value.some((item) => !allowed.includes(item))) fail(code);
}
function display(value) { return plain(value) && exactKeys(value, ["name", "glyph"]) && typeof value.name === "string" && DISPLAY.test(value.name) && typeof value.glyph === "string" && /^[a-z0-9-]{1,40}$/.test(value.glyph); }
function sameArray(left, right) { return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]); }
function positive(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function id(value) { return typeof value === "string" && ID.test(value); }
function version(value) { return typeof value === "string" && VERSION.test(value); }
function timestamp(value) { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function exactKeys(value, expected) { return plain(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail(code) { throw new ConnectorContractError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
