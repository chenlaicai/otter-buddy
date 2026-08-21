import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactMetadataSecrets,
  REDACTED_PLACEHOLDER,
} from "@usecases/security/redact-secrets";

describe("redactSecrets - 已知服务前缀", () => {
  it("脱敏 OpenAI key（sk- 前缀）", () => {
    const key = "sk-1234567890abcdef1234567890abcdef12345678";
    expect(redactSecrets(`我的 key 是 ${key} 别告诉别人`)).toBe(
      `我的 key 是 ${REDACTED_PLACEHOLDER} 别告诉别人`,
    );
  });

  it("脱敏 OpenAI project key（sk-proj- 前缀）", () => {
    const key = "sk-proj-abcdefghij1234567890abcdefghij";
    expect(redactSecrets(key)).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 Anthropic key（sk-ant- 前缀）", () => {
    const key = "sk-ant-api03-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    expect(redactSecrets(key)).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 GitHub token（ghp_ 前缀）", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8".repeat(2);
    expect(redactSecrets(`git remote 用 ${token}`)).toBe(
      `git remote 用 ${REDACTED_PLACEHOLDER}`,
    );
  });

  it("脱敏 AWS access key id（AKIA 前缀）", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(`aws key: ${key}`)).toBe(`aws key: ${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏 Slack token（xoxb- 前缀）", () => {
    const token = "xoxb-fixturefixturefx-fixturefixturefx-fixturefixture";
    expect(redactSecrets(token)).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 Google API key（AIza 前缀）", () => {
    const key = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7";
    expect(redactSecrets(key)).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 JWT（三段 base64url）", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecrets(`Authorization 头是 ${jwt}`)).toBe(
      `Authorization 头是 ${REDACTED_PLACEHOLDER}`,
    );
  });

  it("脱敏 Bearer 凭据（整串替换，含 Bearer 前缀）", () => {
    const bearer = "Authorization: Bearer dO9mZXRyLWJ1ZHlfdG9rZW5fMTIzNDU2Nzg5MGFi";
    expect(redactSecrets(bearer)).toBe(`Authorization: ${REDACTED_PLACEHOLDER}`);
  });
});

describe("redactSecrets - 带标签赋值", () => {
  it("脱敏 api_key: 形式（保留标签）", () => {
    const result = redactSecrets('api_key: "abcdef1234567890abcdef1234567890"');
    expect(result).toBe(`api_key: "${REDACTED_PLACEHOLDER}"`);
  });

  it("脱敏 apiKey = 形式", () => {
    const result = redactSecrets("apiKey = sk_shorterversion1234567890abcd");
    expect(result).toBe(`apiKey = ${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏 app_secret: 形式", () => {
    const result = redactSecrets("app_secret: 0d7f8e9c1b2a3d4f5e6c7b8a9d0e1f2c");
    expect(result).toBe(`app_secret: ${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏中文标签 密码：形式", () => {
    const result = redactSecrets("密码：a1b2c3d4e5f6a7b8c9d0");
    expect(result).toBe(`密码：${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏 config.yaml 风格的多行内容中的每一处", () => {
    const text = [
      "llm:",
      '  apiKey: "sk-abcdefghij1234567890abcdefghij"',
      "feishu:",
      '  appSecret: "v1.0-abcdef1234567890abcdef12"',
    ].join("\n");
    const result = redactSecrets(text);
    expect(result).not.toContain("sk-abcdefghij");
    expect(result).not.toContain("v1.0-abcdef");
    expect((result.match(/\[REDACTED\]/g) ?? []).length).toBe(2);
  });
});

describe("redactSecrets - 误伤防护", () => {
  it("普通中文/英文对话原文不变", () => {
    const text = "用户询问了天气情况，明天去海边玩。The weather is nice today.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("代码片段与 URL 不变", () => {
    const text = "参见 https://github.com/chenlaicai/otter-buddy/pull/366 和 src/usecases/memory/store-memory.ts";
    expect(redactSecrets(text)).toBe(text);
  });

  it("文档中的短占位符示例不变（sk-xxx 等长度不足）", () => {
    const text = "在 config.yaml 里填 apiKey: sk-xxxx（替换成你的 key）";
    expect(redactSecrets(text)).toBe(text);
  });

  it("短密码（<16 字符）不触发带标签规则", () => {
    const text = "password: abc123";
    expect(redactSecrets(text)).toBe(text);
  });

  it("普通含 token 一词的句子（无冒号赋值）不变", () => {
    const text = "这个 token 化方案把文本切成了很多 token。";
    expect(redactSecrets(text)).toBe(text);
  });

  it("空字符串原样返回", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("redactMetadataSecrets", () => {
  it("嵌套对象的字符串值被脱敏，其他类型原样保留", () => {
    const metadata = {
      doc_title: "配置说明",
      note: "api_key: 1234567890abcdef1234567890",
      count: 42,
      flag: true,
      tags: ["安全", "sk-1234567890abcdef1234567890abcdef"],
      nested: { inner: "密码：a1b2c3d4e5f6a7b8c9d0" },
    };
    const result = redactMetadataSecrets(metadata);
    expect(result.note).toContain(REDACTED_PLACEHOLDER);
    expect(result.note).not.toContain("1234567890abcdef1234567890");
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
    expect((result.tags as string[])[1]).toBe(REDACTED_PLACEHOLDER);
    expect((result.nested as Record<string, string>).inner).toBe(
      `密码：${REDACTED_PLACEHOLDER}`,
    );
  });

  it("无命中时返回原引用（=== 成立）", () => {
    const metadata = { a: "普通内容", b: 1 };
    expect(redactMetadataSecrets(metadata)).toBe(metadata);
  });
});
