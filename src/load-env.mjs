import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(".env");
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] == null) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
