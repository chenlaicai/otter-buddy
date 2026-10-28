#!/usr/bin/env node
/**
 * PR 标题 FID/模块形态检查（F20261027fidrx）。
 * 此步骤在 CI build 前运行，故必须零依赖/零编译产物；CommonJS 兼容仓库默认 CJS。
 * FID_STRICT_SEGMENT / MODULE_BANNED 均由元测试与 entities 单一真相源字符级锁镜像。
 */
const FID_STRICT_SEGMENT = String.raw`[a-z]{5}`;
const MODULE_BANNED = new Set(["agent", "runtime", "core", "system", "general", "misc", "other"]);

const title = process.argv.slice(2).join(" ");
const match = title.match(new RegExp(`^\\[([FR]\\d{8}${FID_STRICT_SEGMENT})\\]\\[([a-z]+)\\]`));

if (!match) {
  console.error("❌ PR 标题格式错误");
  console.error(`当前标题: ${title}`);
  console.error("格式：[FYYYYMMDDxxxxx][module][type] 描述");
  console.error("日期后固定 5 位小写字母；不接受中划线、数字或其它长度。历史兼容只作用于读取。");
  process.exit(1);
}

if (MODULE_BANNED.has(match[2])) {
  console.error(`❌ PR 标题模块词「${match[2]}」在禁用清单：无边界/项目本体自指词。`);
  console.error("请改为有边界的子系统名，如 loop/session/guard/context/web/im/conversation/memory/scheduler/skill/prompt/health/ci/docs/otterbar。");
  process.exit(1);
}

console.log("✅ PR 标题格式正确");
