/**
 * F20261009tsts（#1371）：会话级 tool_search——替代 SDK createToolSearchExtension。
 *
 * Why（根因，#1371 三会话三连 stale 实证）：
 * SDK 的 createToolSearchExtension() 在 ResourceLoader 创建时实例化一次（本仓
 * model-runtime-registry.ts 缓存 loader 为进程级单例），工具定义闭包捕获当时的
 * extension ctx。而 pi SDK 的 AgentSession.dispose() 会无条件 invalidate **共享的
 * extension runtime**（loader.js 缓存的 extensionsResult.runtime 一次性实例化、跨
 * session 复用；runner.js:482 invalidate 后 staleMessage 永不恢复）——任一 session
 * 被 dispose（压缩影子通道每次合成后必 dispose、池驱逐同理）后，全进程经
 * extension runtime 的 getActiveTools/setActiveTools 全部抛 ctx stale。
 * otter 自有 customTools 从未中招的原因：其 execute 不访问 extension ctx（闭包
 * 捕获 buildCustomTools 的 ToolContext）。本文件按同一免疫模式实现 tool_search。
 *
 * 机制：
 * - 走 createAgentSession({ customTools }) 路径（session 私有 _customTools，每
 *   invoke 新鲜构建），exposure 默认 direct
 * - 鸡生蛋解法（holder 延迟绑定）：customTools 入参在 session 创建**前**就要传，
 *   但 execute 需要 session 引用——传 holder 对象，session 创建后立即回填
 *   （pi-session-factory._createSessionWithTools）
 * - 激活命中工具用 session.setActiveToolsByName（AgentSession 公开方法，不经过
 *   可失效的 runner；agent-session.js:1099，行为与 SDK 版 tool_search 等价）
 *
 * BM25：vendor 简化实现（SDK 版在包内深处，package.json exports 只开顶层入口，
 * 深导入不可达），词频命中 × idf 权重。中文增强：CJK 连续段切 2-gram（单字歧义
 * 大，bigram 检索友好），与 ASCII 词并列进索引。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** tool_search 可调用的 session 面（AgentSession 的最小结构子集，便于测试替身） */
export interface ToolSearchSessionLike {
  getAllTools(): ReadonlyArray<{
    name: string;
    description?: string;
    /** JSON Schema（TypeBox Static）——检索语料含参数描述与属性名（与 SDK 版对齐，检视发现 1） */
    parameters?: unknown;
  }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

/** 延迟绑定 holder：customTools 传参在 session 创建前，session 引用创建后回填 */
export interface ToolSearchSessionHolder {
  session?: ToolSearchSessionLike;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "for", "of", "and", "or", "to", "in", "with", "by", "on",
  "is", "are", "be", "get", "search", "find", "tool", "tools", "list",
]);

/**
 * 朴素词形还原（与 SDK 版 stem 同语义）：issues→issue、searches→search。
 * 只做英文复数归一，不动其他形态。*/
export function stemToolSearchTerm(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** 递归抽取 JSON Schema 的 description 与属性名（与 SDK 版 schemaText 同语义） */
function schemaText(schema: unknown, parts: string[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const s = schema as Record<string, unknown>;
  if (typeof s.description === "string") parts.push(s.description);
  if (typeof s.properties === "object" && s.properties !== null && !Array.isArray(s.properties)) {
    for (const [name, property] of Object.entries(s.properties as Record<string, unknown>)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(s.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = s[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

/** 工具检索语料：name + _ 换空格的 name + description + 参数 schema 描述与属性名 */
export function buildToolCorpus(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): string {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description ?? ""];
  schemaText(tool.parameters, parts);
  return parts.filter((p) => p.trim()).join(" ");
}

/**
 * 分词：ASCII 词（camelCase 边界拆开 + 去 stop word + stem 词形还原）+ 中文 2-gram。
 * 与 SDK 版 tokenize 语义对齐，增量是 CJK bigram。
 */
export function tokenizeToolSearch(text: string): string[] {
  const terms: string[] = [];
  // camelCase 边界显式拆开：searchMemory → search memory（SDK 版同规则，另含 ALLCAPS→Camel 边界）
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of normalized.match(/[a-z0-9]+/gi) ?? []) {
    const t = stemToolSearchTerm(raw.toLowerCase());
    if (t && !STOP_WORDS.has(t)) terms.push(t);
  }
  for (const seg of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (seg.length === 1) {
      terms.push(seg);
      continue;
    }
    for (let i = 0; i + 1 < seg.length; i++) terms.push(seg.slice(i, i + 2));
  }
  return terms;
}

interface ScoredTool {
  name: string;
  description: string;
  score: number;
}

/** tool_search 的入参（TypeBox schema 的运行时形态） */
interface ToolSearchParams {
  query: string;
  limit?: number;
}

/** 统一结果构造（AgentToolResult 要求 details 字段存在） */
function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError };
}

/**
 * BM25 简化排序（词频命中 × idf）：score = Σ_{t∈query∩doc} idf(t)，
 * idf(t) = ln(1 + N / df(t))，N 为候选工具总数。无命中返回空。
 * 语料经 buildToolCorpus（含参数 schema），分词含 stem 归一（检视发现 1 处置）。
 */
export function rankToolsByQuery(
  query: string,
  candidates: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
  limit: number,
): ScoredTool[] {
  const queryTerms = new Set(tokenizeToolSearch(query));
  if (queryTerms.size === 0) return [];
  // df: term → 出现在多少个候选工具的语料里
  const corpora = candidates.map((t) => new Set(tokenizeToolSearch(buildToolCorpus(t))));
  const df = new Map<string, number>();
  for (const corpus of corpora) {
    for (const term of corpus) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const total = candidates.length;
  const scored: ScoredTool[] = [];
  for (let i = 0; i < total; i++) {
    let score = 0;
    for (const term of queryTerms) {
      if (corpora[i].has(term)) {
        score += Math.log(1 + total / (df.get(term) ?? 1));
      }
    }
    if (score > 0) {
      scored.push({
        name: candidates[i].name,
        description: (candidates[i].description ?? "").split("\n")[0] ?? "",
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * 构建会话级 tool_search 工具定义（customTools 路径，免疫 extension runtime 失效）。
 *
 * @param holder 延迟绑定 holder——pi-session-factory 在 createAgentSession 返回后回填
 * @param limit 单次检索上限（默认 8，与 SDK 版一致）
 */
export function buildSessionToolSearchTool(
  holder: ToolSearchSessionHolder,
  limit = 8,
): ToolDefinition {
  return {
    name: "tool_search",
    label: "Tool discovery",
    description:
      "Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nUse this tool when the task mentions a capability you don't seem to have a tool for: some low-frequency tools are not declared to the model (`deferred` exposure) to keep the tool surface lean. This tool searches that hidden registry (name + description), and matching tools become active and declared on the next model call. Always check here before telling the user a capability is missing.",
    // 改激活集的副作用操作，与其它工具串行执行防并发交错
    executionMode: "sequential",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query for tool discovery (BM25 over tool name + description, CJK 2-gram aware).",
      }),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Maximum number of matching tools to return. Defaults to 8.",
      })),
    }),
     
    execute: async (_toolCallId, params: unknown, _signal, _onUpdate, _ctx) => {
      const session = holder.session;
      if (!session) {
        return textResult(
          "tool_search 错误：session 未绑定（holder 为空）——这是接线缺陷，请报 healing。",
          true,
        );
      }
      const p = (params ?? {}) as Partial<ToolSearchParams>;
      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (!query) {
        return textResult("参数错误：query 必须是非空字符串。", true);
      }
      const requested = typeof p.limit === "number" && p.limit > 0 ? p.limit : limit;
      const active = new Set(session.getActiveToolNames());
      // 检索面 = 已注册但未声明给模型的工具（deferred/codemode 暴露档）
      const candidates = session
        .getAllTools()
        .filter((t) => !active.has(t.name));
      const hits = rankToolsByQuery(query, candidates, requested);
      if (hits.length === 0) {
        return textResult(`没有匹配的工具（query="${query}"，候选 ${candidates.length} 个未声明工具）。换组关键词试试。`);
      }
      // 命中即激活：对下一次模型调用生效（SDK tool_search 同语义）
      const nextActive = [...active, ...hits.map((h) => h.name)];
      session.setActiveToolsByName(nextActive);
      const lines = hits.map((h, i) => `${i + 1}. ${h.name}（score ${h.score.toFixed(2)}）— ${h.description}`);
      return textResult([
        `检索 "${query}" 命中 ${hits.length} 个工具，已加入激活集（下一次模型调用即声明）：`,
        ...lines,
      ].join("\n"));
    },
  };
}
