import { readFileSync } from "node:fs";

const examples = JSON.parse(readFileSync(new URL(
  "../../control_plane/openapi/flowpulse-incident-workflow-v3.examples.json",
  import.meta.url
), "utf8"));

export function v3Examples() {
  return structuredClone(examples);
}

export function v3Projection(overrides = {}) {
  return { ...structuredClone(examples.projection), ...overrides };
}

export function v3Series() {
  return structuredClone(examples.series);
}

export function v3LiveSnapshot() {
  return structuredClone(examples.live_snapshot);
}

export function v3Receipt(commandName = examples.command_receipt.command_name) {
  return { ...structuredClone(examples.command_receipt), command_name: commandName };
}

export function v3Commands() {
  return structuredClone(examples.commands);
}
