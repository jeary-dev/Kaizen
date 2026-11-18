#!/usr/bin/env node
// Live cross-language round trip between the Kotlin (JDK) and TypeScript (WebCrypto)
// implementations, in both directions:
//
//   1. Vitest seals envelopes with random keys and its real CompressionStream -> interop/ts.json
//   2. JUnit opens ts.json, then seals its own with GZIPOutputStream            -> interop/kt.json
//   3. Vitest opens kt.json
//
// Usage: node protocol/tools/interop.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "protocol", "test-vectors", "interop");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const env = { ...process.env, KAIZEN_INTEROP_DIR: dir };
const windows = process.platform === "win32";

const run = (label, command, args, cwd) => {
  console.log(`\n=== ${label}`);
  // Windows can only start the Maven wrapper (.cmd) through a shell. Every argument is a fixed
  // literal without spaces; only the wrapper path is quoted.
  const result = command.endsWith(".cmd")
    ? spawnSync(`"${command}" ${args.join(" ")}`, { cwd, env, stdio: "inherit", shell: true })
    : spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\ninterop failed at: ${label}`);
    process.exit(result.status ?? 1);
  }
};

const web = join(root, "web");
const vitest = [join(web, "node_modules", "vitest", "vitest.mjs"), "run", "src/lib/protocol/protocol.test.ts", "-t", "interop"];
run("TypeScript seals", process.execPath, vitest, web);
run("Kotlin opens and seals", join(root, "plugin", windows ? "mvnw.cmd" : "mvnw"), ["-q", "-B", "-pl", "core", "test", "-Dtest=InteropTest", "-Dsurefire.failIfNoSpecifiedTests=false"], join(root, "plugin"));
run("TypeScript opens", process.execPath, vitest, web);
console.log("\ninterop OK: Kotlin <-> TypeScript, both directions");
