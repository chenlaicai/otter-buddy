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
    const token = "xoxb-1fixturefixturefx-fixturefixturefx-fixturefixtur";
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

  it("脱敏 Bearer 凭据但保留 Bearer 字样", () => {
    const bearer = "Authorization: Bearer dO9mZXRyLWJ1ZHlfdG9rZW5fMTIzNDU2Nzg5MGFi";
    expect(redactSecrets(bearer)).toBe(`Authorization: Bearer ${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏 Stripe key（sk_live_ 前缀）", () => {
    expect(redactSecrets("sk_live_fixturefixturefixturefx")).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 GitHub fine-grained PAT（github_pat_ 前缀）", () => {
    const token = "github_pat_" + "a1B2c3D4e5F6g7H8i9J0".repeat(3);
    expect(redactSecrets(token)).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 GitLab PAT（glpat- 前缀）", () => {
    expect(redactSecrets("glpat-a1b2c3d4e5f6g7h8i9j0")).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 HuggingFace / npm token", () => {
    expect(redactSecrets("hf_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(REDACTED_PLACEHOLDER);
    expect(redactSecrets("npm_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(REDACTED_PLACEHOLDER);
  });

  it("脱敏 PEM 私钥块（多行整体替换）", () => {
    const pem = [
      "部署用的私钥：",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1a2b3c4d5e6f7g8h9i0j1k2l3m4n",
      "5o6p7q8r9s0t1u2v3w4x5y6z7A8B9C0D1E2F3G4H5I6J7",
      "-----END RSA PRIVATE KEY-----",
      "以上。",
    ].join("\n");
    const result = redactSecrets(pem);
    expect(result).not.toContain("MIIEpAIBAAKCAQEA");
    expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result).toContain("部署用的私钥：");
    expect(result).toContain("以上。");
  });

  it("sk-ant- 短于 32 的 key 仍被命中（ant 模式独立于 sk-32 模式）", () => {
    const key = "sk-ant-api03-a1b2c3d4e5f6a7b8c9d0";
    expect(redactSecrets(key)).toBe(REDACTED_PLACEHOLDER);
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

  it("脱敏复合词标签 access_token / client_secret / account_key", () => {
    expect(redactSecrets('access_token: "0123456789abcdef01234567"'))
      .toBe(`access_token: "${REDACTED_PLACEHOLDER}"`);
    expect(redactSecrets("client_secret=6e6f707172737475767778797a"))
      .toBe(`client_secret=${REDACTED_PLACEHOLDER}`);
    expect(redactSecrets("AccountKey: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"))
      .toBe(`AccountKey: ${REDACTED_PLACEHOLDER}`);
  });

  it("脱敏飞书 app_secret（32 位 hex，带标签命中）", () => {
    const secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c9d8";
    expect(redactSecrets(`app_secret: ${secret}`)).toBe(`app_secret: ${REDACTED_PLACEHOLDER}`);
  });

  it("中文标签支持半角冒号（中文用户混用普遍）", () => {
    const result = redactSecrets("密码: AbcdEfgh12345678");
    expect(result).toBe(`密码: ${REDACTED_PLACEHOLDER}`);
  });

  it("中文标签词表含 秘钥/私钥", () => {
    expect(redactSecrets("秘钥：a1b2c3d4e5f6a7b8c9d0e1f2")).toBe(`秘钥：${REDACTED_PLACEHOLDER}`);
    expect(redactSecrets("私钥: a1b2c3d4e5f6a7b8c9d0e1f2")).toBe(`私钥: ${REDACTED_PLACEHOLDER}`);
  });

  it("密码类标签阈值降到 8：8-15 位密码命中", () => {
    expect(redactSecrets("password: hunter2xx")).toBe(`password: ${REDACTED_PLACEHOLDER}`);
    expect(redactSecrets("密码：12345678")).toBe(`密码：${REDACTED_PLACEHOLDER}`);
  });

  it("全角引号包裹的值同样命中", () => {
    expect(redactSecrets('密码：“abcdef12345678”'))
      .toBe(`密码：“${REDACTED_PLACEHOLDER}”`);
  });

  it("值尾部句号视为标点保留，不吞进占位符", () => {
    expect(redactSecrets("密码是 password: abcd1234. 后面还有话。"))
      .toBe(`密码是 password: ${REDACTED_PLACEHOLDER}. 后面还有话。`);
  });
});

describe("redactSecrets - 对抗审视补充用例", () => {
  it("同一文本混合多种密钥（前缀 + labeled + JWT）逐一命中", () => {
    const text = [
      "OpenAI 用 sk-abcdefghij1234567890abcdefghij12",
      "飞书 app_secret: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c9d8",
      "JWT 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
    ].join("\n");
    const result = redactSecrets(text);
    expect((result.match(/\[REDACTED\]/g) ?? []).length).toBe(3);
    expect(result).not.toContain("sk-abcdefghij");
    expect(result).not.toContain("a1b2c3d4e5f6a7b8c9d0");
  });

  it("6000+ 长文本中位于末尾的密钥仍命中（脱敏先于截断的时序保证）", () => {
    const longText = "背景说明。".repeat(1500) + " 密钥：a1b2c3d4e5f6a7b8c9d0e1f2";
    const result = redactSecrets(longText);
    expect(result.endsWith(`密钥：${REDACTED_PLACEHOLDER}`)).toBe(true);
  });

  it("幂等：脱敏结果再过一遍不变", () => {
    const text = "api_key: sk-abcdefghij1234567890abcdefghij，密码: hunter2xx";
    expect(redactSecrets(redactSecrets(text))).toBe(redactSecrets(text));
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

  it("Slack 前缀型普通文字不变（如 xoxb-my-company-token-here）", () => {
    const text = "团队把它叫做 xoxb-my-company-token-here 这个梗";
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
