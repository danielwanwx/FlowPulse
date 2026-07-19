import assert from "node:assert/strict";
import test from "node:test";
import { buildPinnedCheckoutCodeEvidence, isPinnedCheckoutCodeEvidence, PINNED_CHECKOUT_CODE_SPEC } from "../src/code-evidence.mjs";

test("builds bounded code semantics from the exact pinned git object", () => {
  const record = buildPinnedCheckoutCodeEvidence({
    pin: pin(),
    allowlist: allowlist(),
    revision: PINNED_CHECKOUT_CODE_SPEC.commit,
    source: pinnedSource(),
    committedAt: "2026-07-17T14:32:39.000Z",
    capturedAt: "2026-07-18T10:00:00.000Z"
  });
  assert.equal(record.kind, "code");
  assert.equal(record.value.code.content_sha256, PINNED_CHECKOUT_CODE_SPEC.content_sha256);
  assert.equal(record.value.code.path, "src/checkout/main.go");
  assert.equal(record.value.code.line_start, 565);
  assert.equal(record.value.code.line_end, 575);
  assert.equal(record.value.code.verified_from_git_object, true);
  assert.equal(Object.hasOwn(record.value.code, "source"), false);
  assert.equal(isPinnedCheckoutCodeEvidence(record, { target: "checkout", flag: "paymentUnreachable" }), true);
});

test("rejects wrong commit, file, line range, hash, source semantics, and synthetic records", () => {
  const base = { pin: pin(), allowlist: allowlist(), revision: PINNED_CHECKOUT_CODE_SPEC.commit, source: pinnedSource() };
  for (const patch of [
    { allowlist: { ...allowlist(), commit: "0".repeat(40) } },
    { allowlist: { ...allowlist(), path: "src/payment/main.go" } },
    { allowlist: { ...allowlist(), line_start: 564 } },
    { allowlist: { ...allowlist(), content_sha256: "0".repeat(64) } },
    { source: pinnedSource().replace("badAddress:50051", "payment:8080") }
  ]) assert.throws(() => buildPinnedCheckoutCodeEvidence({ ...base, ...patch }), /Pinned checkout code evidence/);
  assert.equal(isPinnedCheckoutCodeEvidence({ kind: "code", value: { code: { ...PINNED_CHECKOUT_CODE_SPEC } } }, { target: "checkout", flag: "paymentUnreachable" }), false);
});

function pin() {
  return { repository: PINNED_CHECKOUT_CODE_SPEC.repository, commit: PINNED_CHECKOUT_CODE_SPEC.commit };
}

function allowlist() { return { id: "astronomy-checkout-payment-unreachable-semantics-v1", ...PINNED_CHECKOUT_CODE_SPEC }; }

function pinnedSource() {
  const prefix = Array.from({ length: 564 }, () => "");
  return [...prefix,
    "func (cs *checkout) chargeCard(ctx context.Context, amount *pb.Money, paymentInfo *pb.CreditCardInfo) (string, error) {",
    "\tpaymentService := cs.paymentSvcClient",
    "\tif flags.PaymentUnreachable.Value(ctx, openfeature.EvaluationContext{}) {",
    "\t\tbadAddress := \"badAddress:50051\"",
    "\t\tc := mustCreateClient(badAddress)",
    "\t\tpaymentService = pb.NewPaymentServiceClient(c)",
    "\t}",
    "",
    "\tpaymentResp, err := paymentService.Charge(ctx, &pb.ChargeRequest{",
    "\t\tAmount:     amount,",
    "\t\tCreditCard: paymentInfo,",
    "\t})"
  ].join("\n");
}
