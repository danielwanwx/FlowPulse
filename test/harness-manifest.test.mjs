import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessManifestError, canonical, harnessBinding, loadHarnessManifest, sha256 } from "../src/harness-manifest.mjs";

test("versioned harness manifest binds the immutable procedures, protocols, and bounded model policy", () => {
  const manifest = loadHarnessManifest();
  const binding = harnessBinding(manifest);
  assert.equal(binding.version, "flowpulse.harness.v1");
  assert.equal(binding.model.store, false);
  assert.equal(binding.model.reasoning_effort, "medium");
  assert.equal(binding.skills.investigator.id, "flowpulse-investigator");
  assert.match(binding.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.budgets.max_tool_rounds, 4);
  assert.equal(manifest.budgets.max_total_tool_calls, 24);
});

test("manifest, skill, protocol, model, and version drift fail closed before a provider request", () => {
  const root = mkdtempSync(join(tmpdir(), "flowpulse-harness-"));
  cpSync(join(process.cwd(), "harness"), join(root, "harness"), { recursive: true });
  const manifestPath = join(root, "harness", "flowpulse-harness.v1.json");
  const skillPath = join(root, "harness", "investigator.v1.md");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nchanged`, "utf8");
  assert.throws(() => loadHarnessManifest({ rootDir: root }), (error) => error instanceof HarnessManifestError && error.code === "harness_skill_hash_mismatch");

  cpSync(join(process.cwd(), "harness"), join(root, "harness"), { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "flowpulse.harness.v999";
  manifest.canonical_sha256 = sha256(canonical({ ...manifest, canonical_sha256: undefined }));
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  assert.throws(() => loadHarnessManifest({ rootDir: root }), (error) => error instanceof HarnessManifestError && error.code === "harness_manifest_version_unknown");

  cpSync(join(process.cwd(), "harness"), join(root, "harness"), { recursive: true, force: true });
  const protocolPath = join(root, "harness", "protocols.v1.json");
  writeFileSync(protocolPath, `${readFileSync(protocolPath, "utf8")} `, "utf8");
  assert.throws(() => loadHarnessManifest({ rootDir: root }), (error) => error instanceof HarnessManifestError && error.code === "harness_protocol_hash_mismatch");
});
