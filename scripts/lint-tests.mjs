#!/usr/bin/env node
/**
 * 测试反模式的机械拦截（commit-time gate）。
 *
 * 拦截清单（全部是可机械判定、零误判的形态——判断性要求靠 skill/文档信道，不在此列）：
 * 1. tests/ 下手写 CREATE TABLE / CREATE VIRTUAL TABLE（必须 createTestDb，防 schema 漂移）
 * 2. tests/ 下重复定义 mockLogger/noopLogger（必须用 tests/helpers/logger 的 createTestLogger）
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts)$/.test(e.name)) out.push(full);
  }
  return out;
}

let violations = 0;
const allowDdlFiles = [];
// 豁免 ratchet——新增 allow-ddl 豁免必须显式上调此上限
// 2→3：tests/scripts/cleanup-memory-pollution.test.ts——运维脚本对任意 DB 的
// 行为测试，被测脚本不读生产 schema 迁移链，临时库手写 DDL 无漂移风险（与 migration 测试同类）
// 3→4：tests/scripts/cleanup-memory-pollution.test.ts——运维脚本对任意 DB 的
// 行为测试，被测脚本不读生产 schema 迁移链，临时库手写 DDL 无漂移风险（与 migration 测试同类）
// （原 4→5/5→6 为 paper-trade 两个仓储测试豁免，炒股能力移除时随测试文件删除，
//  上限 11→9：现存豁免 8 个文件，ratchet 只降不升防新增豁免搭便车）
// 5→6：tests/usecases/health/signal-repository.test.ts——
// 存量库补列迁移测试：需建 8/31 旧形状 signals 表（无 evidence_detail/confidence
// 两列）验证 migrateDatabase ALTER 补列幂等——被测对象就是「旧 schema → 新 schema」迁移本身，
// 用生产 schema 建不出旧表形态（与 migration 同类场景）
// 6→7：tests/frameworks/db/attachments-kind-migration.test.ts——
// 存量库 kind CHECK 扩展迁移测试：需建窄 CHECK（'image','document'）旧形状
// attachments 表验证 rebuildAttachmentsKindCheck 表重建幂等——被测对象就是「旧 schema →
// 新 schema」迁移本身，用生产 schema 建不出旧表形态（与 migration.test.ts 同类场景）
// 7→8：tests/frameworks/db/dispatch-attempt-repo.test.ts——
// 派发台账真实仓储集成测试（rbsg 事故教训：mock 与真实投影的分歧两次酿祸，/）。
// 被测对象是 pending 判据 SQL 与真实投影的交互，手写 seed 需直插 messages/otters
// 原始行（initSchema 建表后无生产写入路径可到达该形状）；与 migration 同类隔离场景
// 8→11：①note-cap.test.ts——capNote 五写路径真库集成，
// 同 dispatch-attempt-repo 场景；②helpers/dispatch-attempt-seed.ts——上述测试的共用
// seed 提取（INSERT 直插 messages/otters，非 DDL 但携带 allow-ddl 标记文件入豁免清单）；
// ③attachments-kind-migration.test.ts——存量库迁移回归，此前漏登记（存量遗留，
// 本次测试范围触及该文件一并归队）
// 9→10：tests/frameworks/db/schema.test.ts——
// 存量库 healing_events 补列/索引顺序回归：需建 前旧形状表（无 bound_issue/bound_at）
// 验证 initSchema 对存量库补列后再建索引不炸——被测对象就是「旧 schema → 新 schema」
// 启动迁移本身，与 migration.test.ts 同类场景
// 10→11：tests/app/build-app-existing-db.test.ts——
// 存量库形态冒烟：需手写 DDL 回退 healing_events 到 前形态（删掉
// bound_issue/bound_at 重建 14 列旧表），被测对象就是「旧 schema → 新 schema」
// 的补列迁移本身，与 migration.test.ts 同类场景
// 11→13：tests/frameworks/db/memory/embedding-task-gate.test.ts +
// tests/scripts/cleanup-embedding-ghosts.test.ts——被测对象是 embedding_tasks
// 表的队列 SQL 语义（enqueueRetry 前置校验 / 幽灵死信 purge/count / 清理脚本
// dry-run/--apply），与 cleanup-memory-pollution.test.ts 同类场景（脚本对象就是表本身）
// 13→14：tests/frameworks/db/unfurl-draft-migration.test.ts——
// 存量库补列迁移专项测试（-4）：需 DROP COLUMN 还原 前
// unfurl_cache 旧形态（无 is_draft）验证 initSchema ALTER 补列幂等 + 老数据读 null，
// 被测对象就是「旧 schema → 新 schema」补列迁移本身（migration-equivalence.guard
// 只做表级等价不覆盖补列路径），与 otter-color-migration.test.ts 同类场景（ALTER 还原旧形态）
// 14→15——新增 embedding-task-priority.test.ts 测 embedding_tasks
// 的 priority 列 SQL 语义（claim 排序/ON CONFLICT 保留），必须建真实表，与
// embedding-task-gate.test.ts 同模式同理由。
// 对抗审视修复：15→16——embed-queue-review-fixes.test.ts 同模式
// （发现 2/3 需真实 SqliteMemoryRepository 的 embedding_tasks/scanDarkEntries 语义）。
const MAX_ALLOW_DDL_FILES = 18;
// 16→17：tests/usecases/conversation/resume-claim-and-summary.test.ts——
// restart_pending_resumes 存量库迁移回归（claim 三列 ALTER 幂等），需手建无 claim 列旧形态表；
// 被测对象就是「旧 schema → 新 schema」迁移本身，与 migration.test.ts 同类场景
// 17→18：tests/frameworks/db/otter-configs-type-check-migration.test.ts——
// otter_configs.otter_type CHECK 扩展 'night-reviewer' 的存量库重建迁移测试：需手建窄 CHECK
// （'big','small'）旧形态 otter_configs 表验证 rebuildOtterConfigsTypeCheck 表重建幂等——
// otter_configs 未纳入 schema.ts（历史原因，仅 migration.ts 一处定义），initSchema 建不出该表，
// 只能手写旧形态 DDL（与 attachments-kind-migration.test.ts 同类场景）。

for (const file of walk(path.join(root, "tests"))) {
  const rel = path.relative(root, file);
  const txt = fs.readFileSync(file, "utf8");

  /** 豁免：文件含 "lint-tests:allow-ddl" 标记（迁移测试需要建旧 schema 的表）；
   * 豁免文件数有 ratchet 上限，新增豁免必须显式上调并过 review；
   *  匹配前剥掉注释行（防注释里的"CREATE TABLE"字样误报） */
  const codeOnly = txt.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const allowDdl = txt.includes("lint-tests:allow-ddl");
  if (allowDdl) allowDdlFiles.push(rel);

  if (!allowDdl && /CREATE\s+(VIRTUAL\s+)?TABLE/i.test(codeOnly)) {
    violations++;
    console.error(`✗ ${rel}\n    手写 DDL（CREATE TABLE）——测试必须用 tests/helpers/createTestDb()（生产 schema），防静默漂移`);
  }
  if (/function\s+(mockLogger|noopLogger)\s*\(/.test(txt)) {
    violations++;
    console.error(`✗ ${rel}\n    重复定义 mockLogger/noopLogger——必须用 tests/helpers/logger 的 createTestLogger()`);
  }
}

if (allowDdlFiles.length > MAX_ALLOW_DDL_FILES) {
  violations++;
  console.error(`✗ allow-ddl 豁免文件 ${allowDdlFiles.length} 个 > 上限 ${MAX_ALLOW_DDL_FILES}：${allowDdlFiles.join(", ")}\n    新增豁免须显式上调 MAX_ALLOW_DDL_FILES 并在 review 中说明理由`);
}

if (violations > 0) {
  console.error(`[lint:tests] ${violations} 个违规`);
  process.exit(1);
}
console.log("[lint:tests] OK");
