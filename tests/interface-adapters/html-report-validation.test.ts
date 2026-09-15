import { describe, it, expect } from "vitest";
import { validateSpeakBody } from "../../src/interface-adapters/agent-runtime/tools/tool-helpers";
import { HTML_REPORT_MAX_PER_MESSAGE } from "@contract/api/html-card";

describe("validateSpeakBody", () => {
  it("空 body 返回错误", () => {
    expect(validateSpeakBody(undefined, "")).toContain("[错误] body 不能为空");
  });

  it("正常 body 通过", () => {
    expect(validateSpeakBody(undefined, "hello world")).toBeNull();
  });

  it("html-card 超过 2 张返回错误", () => {
    const body = '```html-card title="a"\n<x/>\n```\n```html-card title="b"\n<y/>\n```\n```html-card title="c"\n<z/>\n```';
    expect(validateSpeakBody(undefined, body)).toContain("第 3 张起用户会看到降级的源码块");
  });

  describe("html-report 围栏校验", () => {
    it("正常 html-report 通过", () => {
      const body = '```html-report title="议题"\n<h1>内容</h1>\n```';
      expect(validateSpeakBody(undefined, body, 131072)).toBeNull();
    });

    it("html-report 超过 1 张返回错误", () => {
      const body = '```html-report title="议题1"\n<h1>内容1</h1>\n```\n```html-report title="议题2"\n<h1>内容2</h1>\n```';
      expect(validateSpeakBody(undefined, body, 131072)).toContain(`单消息最多 ${HTML_REPORT_MAX_PER_MESSAGE} 张`);
    });

    it("html-report 超过 64KB 返回错误", () => {
      // 生成一个超过 64KB 的 fence 内容（65537 字节 > HTML_REPORT_MAX_BYTES）
      const bigContent = "x".repeat(65537);
      const body = `\`\`\`html-report title="议题"\n${bigContent}\n\`\`\``;
      expect(validateSpeakBody(undefined, body, 131072)).toContain("html-report 卡片内容超限");
    });

    it("html-report 正文散文不计入体积校验", () => {
      // 60KB 正文 + 1KB 报告 = 不应被误杀（Severe 1 修复验证）
      const prose = "a".repeat(60000);
      const reportContent = "x".repeat(1000);
      const body = `${prose}\n\`\`\`html-report title="议题"\n${reportContent}\n\`\`\``;
      expect(validateSpeakBody(undefined, body, 131072)).toBeNull();
    });

    it("html-report 模型 maxTokens < 131072 返回错误", () => {
      const body = '```html-report title="议题"\n<h1>内容</h1>\n```';
      expect(validateSpeakBody(undefined, body, 32768)).toContain("当前模型输出预算");
      expect(validateSpeakBody(undefined, body, 32768)).toContain("32768");
    });

    it("html-report 模型 maxTokens >= 131072 通过", () => {
      const body = '```html-report title="议题"\n<h1>内容</h1>\n```';
      expect(validateSpeakBody(undefined, body, 131072)).toBeNull();
      expect(validateSpeakBody(undefined, body, 262144)).toBeNull();
    });

    it("html-report 未传 maxTokens 时跳过模型路由检查", () => {
      const body = '```html-report title="议题"\n<h1>内容</h1>\n```';
      expect(validateSpeakBody(undefined, body)).toBeNull();
    });

    it("html-card 和 html-report 混合时分别校验", () => {
      // html-card 2 张 + html-report 1 张 = html-card 正好不超限
      const body = '```html-card title="a"\n<x/>\n```\n```html-report title="议题"\n<h1>内容</h1>\n```';
      expect(validateSpeakBody(undefined, body, 131072)).toBeNull();
    });

    it("S5: 围栏写在 speak 外的检测扩展到 html-report", () => {
      // turnAssistantText 含 html-report 围栏，但 cleanBody 不含
      const assistantText = '```html-report title="议题"\n<h1>内容</h1>\n```';
      const cleanBody = "普通文本";
      expect(validateSpeakBody(assistantText, cleanBody)).toContain("html-report 议题汇报卡写在了 speak 之外");
    });

    it("S5: html-card 围栏写在 speak 外的检测仍有效", () => {
      const assistantText = '```html-card title="卡片"\n<x/>\n```';
      const cleanBody = "普通文本";
      expect(validateSpeakBody(assistantText, cleanBody)).toContain("html-card 卡片写在了 speak 之外");
    });
  });
});
