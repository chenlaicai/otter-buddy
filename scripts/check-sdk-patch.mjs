#!/usr/bin/env node
/** F20261105pidr: the execution runtime is durable 1.5.0, not a patched coding-agent. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "node_modules/@earendil-works/pi-durable");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const declarations = readFileSync(resolve(root, "dist/index.d.ts"), "utf8");
const tools = readFileSync(resolve(root, "dist/tools/index.d.ts"), "utf8");
if (pkg.version !== "1.5.0" || !declarations.includes('Harness }') || !tools.includes("createCodingTools")) {
  console.error("[sdk-patch] pi-durable 1.5.0 public Harness/tools installation is missing or inconsistent.");
  process.exit(1);
}
console.log(`[sdk-patch] durable public runtime verified for ${pkg.name}@${pkg.version}`);
