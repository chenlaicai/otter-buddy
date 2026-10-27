#!/usr/bin/env node
/**
 * PR 标题 FID 形态检查（F20261027-fidr）。
 * 与 fid-format.ts 严格 acceptance 同口径；由 tests/entities/document/fid-format.test.ts
 * 字符级锁镜像，CI 只调用本脚本，不再在 YAML 内嵌第四套正则。
 */
import { FID_SUFFIX_SEGMENT } from "../dist/src/entities/document/fid-format.js";

const title = process.argv.slice(2).join(" ");
const pattern = new RegExp(`^\\[[FR]\\d{8}${FID_SUFFIX_SEGMENT}\\]\\[[a-z]+\\]`);

if (!pattern.test(title)) {
  console.error("❌ PR 标题格式错误");
  console.error(`当前标题: ${title}`);
  console.error("格式：[FYYYYMMDD-xxxx][module][type] 描述");
  console.error("后缀推荐 '-' + 4–10 位小写字母数字；字母开头无分隔仅作兼容，数字直连拒绝。");
  console.error("模块: 小写字鬼子系统名（推荐 loop/session/guard/context/web/im/conversation/memory/scheduler/skill/prompt/health/ci/docs/otterbar；清单外开放；agent/runtime/core/system/general/misc/other 禁用，F20260924mseu）");
  process.exit(1);
}
console.log("✅ PR 标题格式正确");
