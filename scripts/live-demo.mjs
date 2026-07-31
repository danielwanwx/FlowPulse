import {
  applyDevelopmentCase,
  developmentChangeManifest,
  developmentStatus,
  readAllowlistedFlagVariant,
  readCheckoutRuntimeIdentity,
  setupDevelopment,
  startDevelopment,
  stopDevelopment,
} from "../src/development-adapter.mjs";

const command = process.argv[2] || "check";
const actions = {
  check: developmentStatus,
  setup: setupDevelopment,
  start: startDevelopment,
  case: applyDevelopmentCase,
  flag: readAllowlistedFlagVariant,
  runtime: readCheckoutRuntimeIdentity,
  manifest: developmentChangeManifest,
  stop: stopDevelopment
};
if (!actions[command]) throw new Error(`Unknown live demo command: ${command}`);
console.log(JSON.stringify(await actions[command](), null, 2));
