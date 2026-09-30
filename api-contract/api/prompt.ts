/**
 * F20260929scfx: 能力库全书——系统提示词与工具清单 DTO。
 *
 * Why: 能力库页面（卷首·心法总纲 + 卷末·兵器谱）需要 SYSTEM.md 分节全文
 * 与运行时真实注册的工具清单，与 /api/skills（卷中·招式秘籍）凑成三编。
 */

/** SYSTEM.md 二级标题切分后的单节 */
export interface SystemSectionDTO {
  /** 节标题（## 之后、行尾锚点之前的文本） */
  title: string;
  /** 节正文（markdown 原文） */
  content: string;
}

/** 工具条目（仅 name + description，不含 inputSchema——展示层不需要） */
export interface ToolItemDTO {
  name: string;
  description: string;
}

export interface PromptBundleDTO {
  /** 系统提示词分节（SYSTEM.md 按 ## 切分；frontmatter 已剥离） */
  system: SystemSectionDTO[];
  /** 运行时注册的工具清单（全集，与 otter 实际可用集合一致） */
  tools: ToolItemDTO[];
}
