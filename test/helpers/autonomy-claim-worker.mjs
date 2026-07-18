import { parentPort, workerData } from "node:worker_threads";
import { Ledger } from "../../src/ledger.mjs";

try {
  const gate = new Int32Array(workerData.gate);
  const ledger = new Ledger(workerData.path);
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0);
  const result = ledger.appendIfAbsent(workerData.event);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: `claim_worker_failed:${String(error?.message || "unknown").slice(0, 160)}` });
}
