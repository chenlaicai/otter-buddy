import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const skillPath = path.join(process.cwd(), ".pi/skills/otter-summon/SKILL.md");
const skill = fs.readFileSync(skillPath, "utf8");
const modelSection = skill.split("## 模型分配规则")[1]?.split("## 产出")[0] ?? "";

describe("otter-summon 模型建议文档契约", () => {
  it("只消费运行时模型清单，不保留任务到固定别名的静态映射", () => {
    expect(modelSection).toContain("当前身份注入的「可用模型」清单");
    expect(modelSection).toContain("get_active_participants");
    expect(modelSection).not.toMatch(/代码\/逻辑\s*→\s*[a-z][a-z0-9-]*/);
    expect(modelSection).not.toMatch(/全局一致性\s*→\s*[a-z][a-z0-9-]*/);
    expect(modelSection).not.toMatch(/中文语义\s*→\s*[a-z][a-z0-9-]*/);
  });

  it("不再推荐运行时已移除的 mimo 族别名", () => {
    expect(modelSection).not.toMatch(/\bmimo(?:-vision)?\b/);
  });
});
