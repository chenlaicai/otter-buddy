/**
 * update-scheduled-task-body.mjs 脚本测试（#430）
 *
 * 覆盖 #428 引入但无测试的两处逻辑 + #406 依赖的落库路径：
 * 1. isDynamicTemplate 单元测试（dynamic 防护——防止静态文案覆盖 DB 占位符 body，#416）
 * 2. loadTemplate direct path 分支：去 frontmatter 正确性（#428 修的 bug 的回归锁）
 * 3. dynamic 模板跳过时 exit 0 且不写库（集成：子进程级）
 * 4. 静态模板同步：写库内容 = 模板去 frontmatter 后逐字节一致（集成：临时 DB + 临时模板目录）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { initSchema } from "@frameworks/db/schema";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SCRIPT = join(import.meta.dirname, "../../scripts/update-scheduled-task-body.mjs");
// ESM import 函数级用例
const { isDynamicTemplate, loadTemplate } = await import(
  `file://${SCRIPT.replace(/\\/g, "/")}`
);

describe("isDynamicTemplate（#430 用例 1：dynamic 防护判定）", () => {
  const wrap = (frontmatter: string, body = "\n内容\n") =>
    `---\n${frontmatter}\n---\n${body}`;

  it("标准 dynamic: true 判定 dynamic", () => {
    expect(isDynamicTemplate(wrap("task_name: x\ndynamic: true"))).toBe(true);
  });

  it("无 dynamic 字段判定非 dynamic", () => {
    expect(isDynamicTemplate(wrap("task_name: x"))).toBe(false);
  });

  it("dynamic: false 判定非 dynamic", () => {
    expect(isDynamicTemplate(wrap("task_name: x\ndynamic: false"))).toBe(false);
  });

  it("带引号值 dynamic: \"true\" 判定 dynamic（#430 列举用例）", () => {
    expect(isDynamicTemplate(wrap('task_name: x\ndynamic: "true"'))).toBe(true);
  });

  it("YAML 规范大写变体 True / TRUE 判定 dynamic（检视 #797 发现 2）", () => {
    expect(isDynamicTemplate(wrap("task_name: x\ndynamic: True"))).toBe(true);
    expect(isDynamicTemplate(wrap("task_name: x\ndynamic: TRUE"))).toBe(true);
  });

  it("行尾注释 dynamic: true # 运行时填充 判定 dynamic", () => {
    expect(isDynamicTemplate(wrap("task_name: x\ndynamic: true # 运行时填充"))).toBe(true);
  });

  it("无 frontmatter 判定非 dynamic", () => {
    expect(isDynamicTemplate("没有 frontmatter 的普通模板\n")).toBe(false);
  });

  it("frontmatter 里其他字段含 dynamic 字样不误判（如 description: dynamic-ish）", () => {
    expect(isDynamicTemplate(wrap("task_name: x\ndescription: some dynamic-ish text"))).toBe(false);
  });
});

describe("loadTemplate（#430 用例 2：direct path 分支去 frontmatter）", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "task-tpl-"));
    // direct path：文件名 = 任务名 kebab 化
    writeFileSync(
      join(dir, "my-task.md"),
      '---\ntask_name: 我的任务\n---\n\n正文第一行\n正文第二行\n',
    );
    // 扫描分支：文件名与任务名无关，frontmatter task_name 匹配
    writeFileSync(
      join(dir, "other-name.md"),
      '---\ntask_name: 扫描任务\n---\n扫描正文\n',
    );
    // 无 frontmatter 的 direct 文件
    writeFileSync(join(dir, "bare-task.md"), "裸内容无 frontmatter\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("direct path：body 为 frontmatter 之后的内容（#428 bug 回归锁）", () => {
    const tpl = loadTemplate("我的任务", dir);
    expect(tpl).not.toBeNull();
    expect(tpl!.body).toBe("\n正文第一行\n正文第二行\n");
    expect(tpl!.path).toBe(join(dir, "my-task.md"));
  });

  it("direct path：无 frontmatter 时 body 为全文", () => {
    const tpl = loadTemplate("bare task", dir);
    expect(tpl!.body).toBe("裸内容无 frontmatter\n");
  });

  it("扫描分支：frontmatter task_name 匹配，body 同样去 frontmatter", () => {
    const tpl = loadTemplate("扫描任务", dir);
    expect(tpl!.body).toBe("扫描正文\n");
    expect(tpl!.path.endsWith("other-name.md")).toBe(true);
  });

  it("无匹配模板返回 null", () => {
    expect(loadTemplate("不存在的任务", dir)).toBeNull();
  });
});

describe("脚本集成行为（#430 用例 3+4：子进程级，临时 DB + 临时模板目录）", () => {
  let tplDir: string;
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(() => {
    tplDir = mkdtempSync(join(tmpdir(), "task-tpl-"));
    dbPath = join(mkdtempSync(join(tmpdir(), "task-db-")), "test.db");
    db = new Database(dbPath);
    initSchema(db); // 生产 schema（lint-tests 规则：禁手写 DDL）
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-x', '测试会话', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, conversation_id, name, cron, timezone, body, talking_stone_passed_to, sender_id, status, consecutive_failures, created_at, updated_at, schedule_type, restart_before_invoke, executor_type) VALUES ('t1', 'conv-x', '每日测试任务', '0 9 * * *', 'Asia/Shanghai', '旧 body', '[]', 'system', 'active', 0, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'cron', 0, 'agent')`,
    ).run();
    // dynamic 模板 + 静态模板各一份
    writeFileSync(
      join(tplDir, "每日-测试-任务.md"),
      "---\ntask_name: 每日测试任务\n---\n\n新 body：静态内容\n",
    );
    // dynamic 模板用扫描分支（文件名故意不匹配，靠 frontmatter task_name）
    writeFileSync(
      join(tplDir, "dyn-tpl.md"),
      "---\ntask_name: 动态测试任务\ndynamic: true\n---\n\n{{PLACEHOLDER}} 静态不该写入\n",
    );
  });

  afterAll(() => {
    db.close();
    rmSync(tplDir, { recursive: true, force: true });
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    execFileSync("node", [SCRIPT, ...args, "--tpl-dir", tplDir], { encoding: "utf8" });

  it("用例 4：静态模板同步——写库 body 与模板去 frontmatter 后逐字节一致", () => {
    const out = run(["--name", "每日测试任务", "--db", dbPath]);
    expect(out).toContain("已更新");
    const row = db
      .prepare(`SELECT body FROM scheduled_tasks WHERE name = '每日测试任务'`)
      .get() as { body: string };
    expect(row.body).toBe("\n新 body：静态内容\n"); // 逐字节 = 去 frontmatter 后原文
    // 幂等：再跑一次应报「已是最新」
    const out2 = run(["--name", "每日测试任务", "--db", dbPath]);
    expect(out2).toContain("已是最新");
  });

  it("用例 3：dynamic 模板跳过——exit 0 且不写库（DB 占位符形态不被覆盖）", () => {
    // 给动态任务先插入占位符 body（模拟调度器生成的形态）
    db.prepare(
      `INSERT INTO scheduled_tasks (id, conversation_id, name, cron, timezone, body, talking_stone_passed_to, sender_id, status, consecutive_failures, created_at, updated_at, schedule_type, restart_before_invoke, executor_type) VALUES ('t2', 'conv-x', '动态测试任务', '0 10 * * *', 'Asia/Shanghai', '动态生成 {{PLACEHOLDER}}', '[]', 'system', 'active', 0, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', 'cron', 0, 'agent')`,
    ).run();
    const out = run(["--name", "动态测试任务", "--db", dbPath]);
    expect(out).toContain("跳过");
    const row = db
      .prepare(`SELECT body FROM scheduled_tasks WHERE name = '动态测试任务'`)
      .get() as { body: string };
    // 占位符形态原样保留，未被静态文案覆盖
    expect(row.body).toBe("动态生成 {{PLACEHOLDER}}");
  });
});
