import * as fs from "node:fs";
import * as path from "node:path";
import { stripFrontmatter } from "@frameworks/agent/prompt-loader";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

/**
 * 仓根定位：本文件编译产物在 <repoRoot>/dist/src/frameworks/agent/（生产 main.js 从 dist/src 起），
 * 向上四级即仓根。alpha 实例 cwd 是数据根（非仓根），不能用 process.cwd()——import.meta.dirname
 * 锚定编译产物位置，跨启动方式（主仓/alpha/worktree）稳定。
 * 兜底：dist 路径不存在时退回 process.cwd()。
 */
function resolveRepoRoot(): string {
  // 编译产物在 <repoRoot>/dist/src/frameworks/agent/（生产），dev 下直接跑 src/ 布局——
  // 两种布局上溯层级不同（dist 4 级、src 3 级），逐一候选 + .pi/SYSTEM.md 存在性校验，
  // 全不命中再回退 process.cwd()（vitest 从仓根跑时兜底有效）。
  const candidates = [
    path.resolve(import.meta.dirname, "..", "..", "..", ".."),
    path.resolve(import.meta.dirname, "..", "..", ".."),
    process.cwd(),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, ".pi", "SYSTEM.md"))) ?? process.cwd();
}

/**
 * F20260929scfx：能力库全书数据源辅助——skill 正文与 SYSTEM.md 分节的文件读取。
 * 从 app.ts 拆出（lint max-lines）：失败均降级空值，不抛错（页面该节只少内容，不整页消失）。
 */

/** 按约定路径读 skill 正文（frontmatter 之后全文）。读失败降级 ''。 */
export function readSkillBody(name: string): string {
  try {
    const filePath = path.resolve(resolveRepoRoot(), ".pi/skills", name, "SKILL.md");
    if (!fs.existsSync(filePath)) return "";
    return stripFrontmatter(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return "";
  }
}

/**
 * 读 .pi/SYSTEM.md 并按二级标题（## ）切分为 sections。
 * 首个 ## 之前的引言（标题段）并入第一编，不丢弃；
 * 若首 `##` 出现在代码围栏内则不视为分节边界（防误切）。
 * 文件缺失/读失败降级空数组。
 */
export function readSystemSections(): Array<{ title: string; content: string }> {
  try {
    const filePath = path.resolve(resolveRepoRoot(), ".pi/SYSTEM.md");
    if (!fs.existsSync(filePath)) return [];
    const raw = stripFrontmatter(fs.readFileSync(filePath, "utf-8"));
    return splitByH2(raw);
  } catch {
    return [];
  }
}

/** 按 ## 二级标题切分 markdown；行内锚点（## 标题 {#id}）剥为纯标题。
 *  首 ## 前的引言独立成节（UI 上空标题显示「卷首语」）；代码围栏内的 ## 不视为分节边界。 */
function splitByH2(markdown: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string }> = [];
  const state = {
    current: null as { title: string; content: string } | null,
    inFence: false,
    preamble: [] as string[],
  };
  for (const line of markdown.split("\n")) {
    consumeLine(line, state, sections);
  }
  if (state.current) sections.push(state.current);
  else if (state.preamble.length > 0) {
    // 全文无 ##：整体作单节
    const text = state.preamble.join("\n").trim();
    if (text) sections.push({ title: "", content: text });
  }
  return sections
    .map((s) => ({ title: s.title, content: s.content.trim() }))
    .filter((s) => s.title || s.content);
}

interface SplitState {
  current: { title: string; content: string } | null;
  inFence: boolean;
  preamble: string[];
}

/** 单行喂入切分状态机：围栏翻转 → 分节边界判定 → 内容累积/前言累积。
 *  首个 ## 到达时，先把已累积的引言（若有）作为独立节入列，再开新节。 */
function consumeLine(line: string, state: SplitState, sections: Array<{ title: string; content: string }>): void {
  if (/^\s*```/.test(line)) state.inFence = !state.inFence;
  const m = state.inFence ? null : line.match(/^##\s+(.+?)\s*$/);
  if (m) {
    if (state.current) {
      sections.push(state.current);
    } else if (state.preamble.length > 0) {
      // 首 ## 前的引言：独立成节（UI 上空标题显示为「卷首语」）
      const text = state.preamble.join("\n").trim();
      if (text) sections.push({ title: "", content: text });
    }
    state.current = { title: m[1].replace(/\s*\{[^}]*\}\s*$/, "").trim(), content: "" };
  } else if (state.current) {
    state.current.content += line + "\n";
  } else {
    state.preamble.push(line);
  }
}

/** 工具清单聚合：createTools 空 ctx 只得无条件基础集（27 件）。
 *  条件注册工具（healing/workspace/scheduled/signal/rhi 等）依运行时环境挂载，不在本清单。
 *  本清单供能力库兵器谱展示「系统会什么」的基线答案；取 name+description（不取 inputSchema）。 */
export function listAllToolSummaries(): Array<{ name: string; description: string }> {
  return createTools({ client: undefined as never, otterId: "", conversationId: "" } as never).map(
    (t) => ({ name: t.name, description: t.description }),
  );
}
