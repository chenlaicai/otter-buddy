#!/usr/bin/env bash
# 双分支模型可见输入 parity：基线 capture → 当前 compare。
# 测试装置取当前分支，保证两侧断言/规范化器一致；被测 src 分别属于各自分支。
set -euo pipefail

BASE="${1:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)"
# 精确许可绑定真实比较基线，而不是会随其他 PR 合入移动的 main 尖端。
# rebase 改变 merge-base 时仍必须重跑并更新许可；无关 main 前进不产生假红。
BASE_SHA="$(git -C "$ROOT" merge-base HEAD "$BASE")"
REGISTRY="$ROOT/tests/capability/guardrails.json"
HITS="$(node --input-type=module - "$ROOT" "$BASE" <<'NODE'
import { changedPathsFromGit } from './scripts/check-capability-change.mjs';
import { loadCapabilityRegistry, matchingCapabilityChanges } from './scripts/lint-capability-guardrails.mjs';
const root = process.argv[2];
const base = process.argv[3];
process.chdir(root);
const hits = matchingCapabilityChanges(changedPathsFromGit(base), loadCapabilityRegistry(root));
process.stdout.write(hits.join('\n'));
NODE
)"
if [[ -z "$HITS" ]]; then
  echo "[capability-parity] 无相关变更，跳过双分支比对（零 LLM 成本）"
  exit 0
fi
printf '[capability-parity] 变更触发：\n%s\n' "$HITS"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/otter-capability-parity.XXXXXX")"
BASE_WORKTREE="$TMP/base"
cleanup() {
  git -C "$ROOT" worktree remove --force "$BASE_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$ROOT" worktree add --detach "$BASE_WORKTREE" "$BASE_SHA"
# 共用已安装依赖；被测源码与 dist 均留在各自 worktree，互不覆盖。
ln -s "$ROOT/node_modules" "$BASE_WORKTREE/node_modules"
rm -rf "$BASE_WORKTREE/tests/capability"
cp -R "$ROOT/tests/capability" "$BASE_WORKTREE/tests/capability"

(
  cd "$BASE_WORKTREE"
  npm run build
  OTTER_TEST_LLM_API_KEY='' OTTER_TEST_LLM_MODEL='' \
    A3_SNAPSHOT_CAPTURE="$TMP/baseline.json" \
    npx vitest run --config vitest.capability.config.ts \
    tests/capability/model-visible-parity.capability.test.ts
)
node --input-type=module - "$ROOT" "$BASE_SHA" "$TMP/allow.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [root, base, out] = process.argv.slice(2);
const file = path.join(root, 'tests/capability/parity-allowlist.json');
const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
const entry = registry.allowances.find(item => item.base === base);
fs.writeFileSync(out, JSON.stringify(entry?.diffs ?? []));
NODE
(
  cd "$ROOT"
  npm run build
  OTTER_CAPABILITY_FORCE_FAUX=1 OTTER_TEST_LLM_API_KEY='' OTTER_TEST_LLM_MODEL='' \
    A3_SNAPSHOT_FILE="$TMP/baseline.json" A3_SNAPSHOT_ALLOW_FILE="$TMP/allow.json" \
    npx vitest run --config vitest.capability-faux.config.ts \
    tests/capability/model-visible-parity.capability.test.ts
)
echo "[capability-parity] PASS：基线 $BASE ($BASE_SHA) 与当前 HEAD 无未登记 wire 漂移"
