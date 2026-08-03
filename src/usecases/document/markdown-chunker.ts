/**
 * F20260803chunk: 文档分段索引（chunking）。
 *
 * 把特性/研究文档的 body 按标题结构切成多个 chunk。每个 chunk 是独立 memory_entry
 * 的内容来源。分段在原始 markdown 上进行（保留标题井号），逐 chunk 清理在
 * indexFeatureChunks/indexResearchChunks 内做（决策 D2 关键顺序）。
 *
 * 分段策略（基于 91 个文档实测：100% 有 H2，97.8% section <2000 字符）：
 * 1. 短文档（< CHUNK_THRESHOLD）→ 单 chunk
 * 2. 按 H2 切；H2 section 超阈值 → 下沉 H3
 * 3. H3 仍超阈值 → 按段落 + 代码块兜底切分（代码块原子化）
 * 4. 短 chunk（< MIN_CHUNK_SIZE）合并到相邻
 *
 * H1 标题忽略（文档标题已在 frontmatter.title，不参与分段）。
 * H4/H5/H6 不单独分段，作为 H3 内容保留。
 */

/** 一个分段后的 chunk（原始 markdown，未清理） */
export interface MarkdownChunk {
  /** 原始 markdown 内容（含标题井号，清理在索引时做） */
  content: string;
  /** 标题路径，如 ["背景", "问题"]；短文档单 chunk 为 [] */
  headingPath: string[];
  /** 原始 markdown 字符数（非 FTS 索引字符数） */
  charCount: number;
}

/** 单 chunk 最大字符数（超此值触发下沉切分） */
const CHUNK_THRESHOLD = 3000;
/** 最小 chunk 字符数，小于此值合并到相邻 chunk */
const MIN_CHUNK_SIZE = 50;
/** 未闭合代码块兜底：超此字符数按行强制切分（CHUNK_THRESHOLD × 2） */
const MAX_CODEBLOCK_FORCE_SPLIT = 6000;

/** splitByHeadingLevel 返回的原始 section */
interface RawSection {
  /** 标题文本（null 表示前言段落，即第一个指定级别标题之前的内容） */
  title: string | null;
  /** 含标题行（如有）+ 后续内容 */
  body: string;
}

/** splitIntoAtomicBlocks 返回的原子单元 */
interface Block {
  type: "paragraph" | "codeblock";
  text: string;
}

/**
 * 把 body 切成多个 chunk。纯函数，无 IO。
 *
 * @param body frontmatter 之后的原始 markdown 正文
 * @returns chunk 数组（空 body 返回 []）
 */
export function chunkMarkdown(body: string): MarkdownChunk[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  // 去掉 H1 标题行（文档标题已在 frontmatter.title，不参与分段）
  // ^#\s+ 精确匹配 H1（不匹配 H2 的 "## "，因第二个字符 # 非 \s）
  const bodyNoH1 = body.replace(/^#\s+[^\n]+/gm, "").replace(/^\n+/, "");
  if (!bodyNoH1.trim()) return [];

  // 短文档：整个 body 作为一个 chunk
  if (bodyNoH1.length < CHUNK_THRESHOLD) {
    return [{ content: bodyNoH1, headingPath: [], charCount: bodyNoH1.length }];
  }

  const chunks = processLevel(bodyNoH1, 2, []);
  return mergeShortChunks(chunks);
}

/**
 * 按指定 heading level 处理 text，递归下沉。
 * level=2 按 H2 切；超阈值下沉 level=3；level=3 超阈值按段落+代码块切。
 */
function processLevel(text: string, level: number, parentPath: string[]): MarkdownChunk[] {
  const sections = splitByHeadingLevel(text, level);
  const chunks: MarkdownChunk[] = [];

  for (const section of sections) {
    const headingPath = section.title ? [...parentPath, section.title] : [...parentPath];

    if (section.body.length <= CHUNK_THRESHOLD) {
      chunks.push({ content: section.body, headingPath, charCount: section.body.length });
    } else if (level < 3) {
      // 下沉到更深层级
      chunks.push(...processLevel(section.body, level + 1, headingPath));
    } else {
      // H3 仍超阈值：段落 + 代码块兜底切分
      chunks.push(...splitByParagraphsAndCodeblocks(section.body, headingPath));
    }
  }

  return chunks;
}

/**
 * 按指定 heading level 分割 text。
 * 只切指定 level 的标题（精确匹配 # 数量）。更高级别标题（外层已切好，通常不出现）
 * 和更低级别标题都作为内容的一部分。第一个指定级别标题之前的内容是前言 section
 * （title=null）。
 */
function splitByHeadingLevel(text: string, level: number): RawSection[] {
  const lines = text.split("\n");
  const sections: RawSection[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  // 精确匹配指定 level：#{level} 后面不能紧跟 #（否则是更深层级）
  const headingRegex = new RegExp(`^#{${level}}(?!#)\\s+(.+)$`);

  const flush = () => {
    const body = currentLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (body) {
      sections.push({ title: currentTitle, body });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(headingRegex);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * H3 section 仍超阈值时，按段落 + 代码块兜底切分。
 * 代码块（``` 或 ~~~ 围栏）是不可分割的原子单元。
 */
function splitByParagraphsAndCodeblocks(text: string, headingPath: string[]): MarkdownChunk[] {
  const blocks = splitIntoAtomicBlocks(text);
  const chunks: MarkdownChunk[] = [];
  let current = "";

  const emitCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push({ content: trimmed, headingPath, charCount: trimmed.length });
    }
    current = "";
  };

  for (const block of blocks) {
    // 单个 codeblock 超阈值：M4 兜底，按行强制切分
    if (block.type === "codeblock" && block.text.length > MAX_CODEBLOCK_FORCE_SPLIT) {
      emitCurrent();
      const forcedChunks = forceSplitByLines(block.text, headingPath);
      chunks.push(...forcedChunks);
      continue;
    }

    // 累积：加入下一个 block 不超阈值则累积，否则 emit 当前
    if ((current + "\n" + block.text).length > CHUNK_THRESHOLD && current.trim()) {
      emitCurrent();
    }
    current = current ? current + "\n" + block.text : block.text;
  }
  emitCurrent();

  return chunks;
}

/**
 * 把 text 拆成原子单元（paragraph / codeblock）。
 * 代码块用状态机识别（同时支持 ``` 和 ~~~ 围栏），避免正则难处理嵌套/缩进/未闭合。
 */
function splitIntoAtomicBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (current.length > 0) {
      const text = current.join("\n").trim();
      if (text) blocks.push({ type: "paragraph", text });
      current = [];
    }
  };

  for (const line of lines) {
    if (isFenceLine(line)) {
      if (inCode) {
        // 代码块结束
        current.push(line);
        blocks.push({ type: "codeblock", text: current.join("\n") });
        current = [];
        inCode = false;
      } else {
        // 代码块开始
        flushParagraph();
        current.push(line);
        inCode = true;
      }
    } else if (!inCode && line.trim() === "") {
      // 空行：段落边界（非代码块内）
      flushParagraph();
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    // tail flush：未闭合代码块作为 codeblock（M4 兜底在调用方处理超长）
    const text = current.join("\n").trim();
    if (text) blocks.push({ type: inCode ? "codeblock" : "paragraph", text });
  }
  return blocks;
}

/** M2 修正：同时识别 ``` 和 ~~~ 围栏（CommonMark 两种合法 fenced code block） */
function isFenceLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

/** M4 兜底：超大 codeblock 按行强制切分（每 CHUNK_THRESHOLD 一段） */
function forceSplitByLines(text: string, headingPath: string[]): MarkdownChunk[] {
  const lines = text.split("\n");
  const chunks: MarkdownChunk[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > CHUNK_THRESHOLD && current) {
      chunks.push({ content: current, headingPath, charCount: current.length });
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) {
    chunks.push({ content: current, headingPath, charCount: current.length });
  }
  return chunks;
}

/**
 * 短 chunk 合并：charCount < MIN_CHUNK_SIZE 的 chunk 合并到相邻。
 * 非末尾合并到下一个；末尾合并到前一个。合并后 headingPath 用合并目标的。
 */
function mergeShortChunks(chunks: MarkdownChunk[]): MarkdownChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: MarkdownChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.charCount >= MIN_CHUNK_SIZE) {
      merged.push(chunk);
      continue;
    }
    // 短 chunk：合并到前一个（如有）或后一个
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.content = prev.content + "\n" + chunk.content;
      prev.charCount = prev.content.length;
      // headingPath 保留 prev 的（更精确的定位）
    } else if (i + 1 < chunks.length) {
      const next = chunks[i + 1];
      next.content = chunk.content + "\n" + next.content;
      next.charCount = next.content.length;
    } else {
      // 只有一个短 chunk，直接保留
      merged.push(chunk);
    }
  }
  return merged;
}
