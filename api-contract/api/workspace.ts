/**
 * Workspace API DTO —— 单一真相源（issue #558，迁移自 usecase/web 两侧内联副本）。
 *
 * GET /api/conversations/:id/workspace        → WorkspaceListDirResponse
 * GET /api/conversations/:id/workspace/file   → WorkspaceFileContent
 *
 * 三侧消费同一来源，靠双端 tsc 锁死漂移：
 * - src/usecases/conversation/manage-workspace.ts（生产侧签名）
 * - src/interface-adapters/http/controllers/workspace-controller.ts（HTTP 响应体）
 * - web/src/pages/conversation/WorkspacePanel.tsx（前端 fetch 解析）
 *
 * 注：GET .../workspace/stats 的响应体仅后端单侧使用（无 web 消费），
 * 按 api-contract/README.md 准入标准（"仅单端使用的类型不进本目录"）不纳入契约。
 */

/** 工作区文件条目 */
export interface WorkspaceEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  /** 相对于工作区根目录的路径（嵌套条目为 `父路径/名称` 形态） */
  path: string;
}

/** 工作区文件内容（超过显示层 100KB 上限时截断并置 truncated） */
export interface WorkspaceFileContent {
  /** 相对于工作区根目录的文件路径（即请求的 path 参数） */
  path: string;
  content: string;
  truncated: boolean;
}

/** GET /api/conversations/:id/workspace 响应体 */
export interface WorkspaceListDirResponse {
  entries: WorkspaceEntry[];
  /** 请求的 path 参数（缺省为根目录时为空串） */
  basePath: string;
}
