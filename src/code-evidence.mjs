import { createHash } from "node:crypto";

export const PINNED_CHECKOUT_CODE_SPEC = Object.freeze({
  repository: "https://github.com/open-telemetry/opentelemetry-demo.git",
  commit: "18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5",
  path: "src/checkout/main.go",
  line_start: 565,
  line_end: 575,
  content_sha256: "da8ec864c0882d90f822bf06c42ffc2104e86b65ee4acdb2cb6238ccad137c69",
  target: "checkout",
  flag: "paymentUnreachable",
  bad_address: "badAddress:50051",
  charge_operation: "PaymentService.Charge",
  semantic_fact: "At the pinned commit, paymentUnreachable=true replaces checkout's normal Payment client with badAddress:50051 before PaymentService.Charge."
});

export function buildPinnedCheckoutCodeEvidence({ pin, allowlist, revision, source, committedAt, capturedAt = new Date().toISOString() }) {
  assertExactSpec(pin, allowlist, revision);
  if (typeof source !== "string") throw invalid("source is unavailable");
  const snippet = `${source.split(/\r?\n/).slice(allowlist.line_start - 1, allowlist.line_end).join("\n")}\n`;
  const contentHash = sha256(snippet);
  if (contentHash !== allowlist.content_sha256) throw invalid("content hash differs from the allowlist");
  assertSemantics(snippet);
  if (!Number.isFinite(Date.parse(committedAt || "")) || !Number.isFinite(Date.parse(capturedAt || ""))) {
    throw invalid("timestamps are unavailable");
  }
  return {
    id: `code-${contentHash.slice(0, 16)}`,
    kind: "code",
    signal: "code",
    title: "Pinned checkout payment-unreachable implementation semantics",
    fact: allowlist.semantic_fact,
    entity: allowlist.target,
    source: "verified pinned official git object",
    at: committedAt,
    captured_at: capturedAt,
    value: {
      code: {
        id: allowlist.id,
        repository: allowlist.repository,
        commit: allowlist.commit,
        path: allowlist.path,
        line_start: allowlist.line_start,
        line_end: allowlist.line_end,
        content_sha256: contentHash,
        target: allowlist.target,
        flag: allowlist.flag,
        bad_address: allowlist.bad_address,
        charge_operation: allowlist.charge_operation,
        semantic_fact: allowlist.semantic_fact,
        verified_from_git_object: true
      }
    },
    hash: contentHash,
    provenance: {
      file: allowlist.path,
      line: allowlist.line_start,
      line_end: allowlist.line_end,
      sha256: contentHash,
      repository: allowlist.repository,
      commit: allowlist.commit,
      immutable_capture: true,
      verified_from_git_object: true
    }
  };
}

export function isPinnedCheckoutCodeEvidence(record, change = {}) {
  const code = record?.value?.code || {};
  const provenance = record?.provenance || {};
  return record?.kind === "code"
    && record.id === `code-${PINNED_CHECKOUT_CODE_SPEC.content_sha256.slice(0, 16)}`
    && record.hash === PINNED_CHECKOUT_CODE_SPEC.content_sha256
    && code.content_sha256 === PINNED_CHECKOUT_CODE_SPEC.content_sha256
    && Object.entries(PINNED_CHECKOUT_CODE_SPEC).every(([key, value]) => code[key] === value)
    && code.verified_from_git_object === true
    && provenance.repository === PINNED_CHECKOUT_CODE_SPEC.repository
    && provenance.commit === PINNED_CHECKOUT_CODE_SPEC.commit
    && provenance.file === PINNED_CHECKOUT_CODE_SPEC.path
    && provenance.line === PINNED_CHECKOUT_CODE_SPEC.line_start
    && provenance.line_end === PINNED_CHECKOUT_CODE_SPEC.line_end
    && provenance.sha256 === PINNED_CHECKOUT_CODE_SPEC.content_sha256
    && provenance.immutable_capture === true
    && provenance.verified_from_git_object === true
    && change.target === PINNED_CHECKOUT_CODE_SPEC.target
    && change.flag === PINNED_CHECKOUT_CODE_SPEC.flag;
}

function assertExactSpec(pin = {}, allowlist = {}, revision) {
  for (const [key, expected] of Object.entries(PINNED_CHECKOUT_CODE_SPEC)) {
    if (allowlist[key] !== expected) throw invalid(`${key} differs from the allowlist`);
  }
  if (!allowlist.id || pin.repository !== PINNED_CHECKOUT_CODE_SPEC.repository
    || pin.commit !== PINNED_CHECKOUT_CODE_SPEC.commit || revision !== PINNED_CHECKOUT_CODE_SPEC.commit) {
    throw invalid("repository revision is not the reviewed pin");
  }
}

function assertSemantics(snippet) {
  const terms = [
    "paymentService := cs.paymentSvcClient",
    "flags.PaymentUnreachable.Value",
    'badAddress := "badAddress:50051"',
    "paymentService = pb.NewPaymentServiceClient(c)",
    "paymentService.Charge"
  ];
  let position = -1;
  for (const term of terms) {
    const next = snippet.indexOf(term);
    if (next <= position) throw invalid("expected flag-to-client-to-charge semantics are absent");
    position = next;
  }
}

function invalid(reason) { return new Error(`Pinned checkout code evidence ${reason}`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
