/** FTS5 查询转义：包装为 phrase query，防止特殊字符被解释为操作符 */
export function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
