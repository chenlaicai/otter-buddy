import { describe, it, expect } from "vitest";
import { escapeFtsQuery } from "@frameworks/db/fts-utils";

describe("escapeFtsQuery", () => {
  it("将查询包裹在双引号中，用于短语匹配", () => {
    const result = escapeFtsQuery("hello world");
    expect(result).toBe('"hello world"');
  });

  it("转义嵌入的双引号（单引号变为两个双引号）", () => {
    const result = escapeFtsQuery('say "hello"');
    expect(result).toBe('"say ""hello"""');
  });

  it("空字符串返回空的双引号包裹", () => {
    const result = escapeFtsQuery("");
    expect(result).toBe('""');
  });

  it("单引号不需要转义", () => {
    const result = escapeFtsQuery("it's a test");
    expect(result).toBe('"it\'s a test"');
  });

  it("多个双引号全部被转义", () => {
    const result = escapeFtsQuery('"a" and "b"');
    expect(result).toBe('"""a"" and ""b"""');
  });

  it("包含特殊字符的查询仍然被正确包裹", () => {
    const result = escapeFtsQuery("hello: world AND OR NOT");
    expect(result).toBe('"hello: world AND OR NOT"');
  });

  it("纯数字查询正确包裹", () => {
    const result = escapeFtsQuery("12345");
    expect(result).toBe('"12345"');
  });
});
