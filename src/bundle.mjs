import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultBundleUrl = new URL("../data/incidents/astronomy-checkout.json", import.meta.url);

export function loadBundle(path = fileURLToPath(defaultBundleUrl)) {
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  validateBundle(bundle);
  return bundle;
}

export function validateBundle(bundle) {
  if (bundle?.schema_version !== 1 || !bundle.incident?.id) {
    throw new Error("Unsupported incident bundle");
  }
  const ids = new Set();
  for (const item of bundle.evidence ?? []) {
    if (!item.id || ids.has(item.id)) throw new Error(`Invalid evidence id: ${item.id}`);
    ids.add(item.id);
  }
  for (const id of bundle.repair?.verification_evidence ?? []) {
    if (!ids.has(id)) throw new Error(`Repair references missing evidence: ${id}`);
  }
  return bundle;
}

export function evidenceById(bundle, ids) {
  const wanted = new Set(ids);
  return bundle.evidence.filter((item) => wanted.has(item.id));
}

export function queryEvidence(bundle, { kind, entity } = {}) {
  return bundle.evidence.filter((item) => (!kind || item.kind === kind) && (!entity || item.entity === entity));
}
