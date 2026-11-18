#!/usr/bin/env node
/**
 * F20261117cnnct（#1868 阶段 4）：connector 构建产物依赖闭包断言（方案 v3 §7）。
 *
 * 轻量铁律的构建级硬约束：dist/connector 的 import 图不得出现模型/embedding/记忆/
 * agent 全家桶节点（issue 阶段 4「不加载模型、embedding 或主记忆」）。eslint 边界
 * 是早期软拦截，本脚本是产物级硬闸（CI 跑）。
 *
 * 用法：先 npm run build:connector 再 node scripts/check-connector-closure.mjs
 *   （check 聚合里已串好顺序）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const distRoot = path.resolve("dist/connector");

const FORBIDDEN = [
  /@frameworks\/agent/,
  /@frameworks\/llm/,
  /@frameworks\/embedding/,
  /@frameworks\/memory/,
  /@frameworks\/db\/(conversation|otter|memory|im)/, // 主库领域 repo（中枢数据）
  /@earendil-works\/(pi-ai|pi-coding-agent|pi-agent-core|chord)/,
  /@interface-adapters/,
  /@usecases\/(?!ports\/(logger|connector-registry-repository|execution-machine))/,
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const patterns = [/from\s+["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g, /require\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

let violations = 0;
for (const file of walk(distRoot)) {
  for (const spec of importsOf(file)) {
    if (spec.startsWith("node:")) continue; // node 内置放行
    if (spec.startsWith(".")) {
      // 相对 import（tsc-alias 后产物内部树）：解析后必须仍在 dist/connector 内（防 ../ 逃逸）
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(distRoot)) {
        process.stdout.write(`✖ ${path.relative(distRoot, file)} escapes dist via ${spec}\n`);
        violations += 1;
      }
      continue;
    }
    for (const re of FORBIDDEN) {
      if (re.test(spec)) {
        process.stdout.write(`✖ ${path.relative(distRoot, file)} imports ${spec}\n`);
        violations += 1;
      }
    }
  }
}

if (violations > 0) {
  process.stdout.write(`connector closure check FAILED: ${violations} violation(s)——轻量铁律被破坏（模型/embedding/记忆/agent 依赖进入 connector 产物）\n`);
  process.exit(1);
}
process.stdout.write("connector closure check PASS（产物 import 图零违禁节点）\n");
