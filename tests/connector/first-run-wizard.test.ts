import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findBootstrapPrefill,
  normalizeHubUrl,
  normalizePairingCode,
  parseBootstrapJson,
} from "../../src/connector/first-run-wizard";

/**
 * 首启向导纯函数单测：hub/码规范化、bootstrap 解析与发现顺序。
 * 交互流程（readline）不走单测——由真实 PTY 证据覆盖（见 PR 证据层）。
 */

describe("normalizeHubUrl", () => {
  it("接受 http/https、去尾斜杠、trim；其余一律拒绝", () => {
    expect(normalizeHubUrl("  https://otter.example.com/  ")).toBe("https://otter.example.com");
    expect(normalizeHubUrl("http://192.168.1.10:3000/")).toBe("http://192.168.1.10:3000");
    expect(normalizeHubUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeHubUrl("https://otter.example.com/hub/")).toBe("https://otter.example.com/hub");
    expect(normalizeHubUrl("")).toBeNull();
    expect(normalizeHubUrl("otter.example.com")).toBeNull();
    expect(normalizeHubUrl("ftp://otter.example.com")).toBeNull();
    expect(normalizeHubUrl("https://")).toBeNull();
  });
});

describe("normalizePairingCode", () => {
  it("trim+大写后匹配 8 位字母表；含 0/1/I/O 或长度不对拒绝", () => {
    expect(normalizePairingCode("  ab2cd3ef  ")).toBe("AB2CD3EF");
    expect(normalizePairingCode("AB2CD3E0")).toBeNull(); // 0 不在字母表
    expect(normalizePairingCode("AB2CD3E1")).toBeNull(); // 1 不在字母表
    expect(normalizePairingCode("AB2CD3E")).toBeNull(); // 7 位
    expect(normalizePairingCode("")).toBeNull();
  });
});

describe("parseBootstrapJson", () => {
  const NOW = Date.parse("2026-11-24T12:00:00.000Z");

  it("合法结构给出 hub+code；各字段独立校验", () => {
    expect(parseBootstrapJson(JSON.stringify({ hub: "https://hub.example.com/", pairingCode: "ab2cd3ef", expiresAt: "2026-11-24T13:00:00.000Z" }), NOW))
      .toEqual({ hub: "https://hub.example.com", pairingCode: "AB2CD3EF" });
    expect(parseBootstrapJson(JSON.stringify({ hub: "https://hub.example.com" }), NOW))
      .toEqual({ hub: "https://hub.example.com" });
    expect(parseBootstrapJson(JSON.stringify({ pairingCode: "AB2CD3EF", expiresAt: "2026-11-24T13:00:00.000Z" }), NOW))
      .toEqual({ pairingCode: "AB2CD3EF" });
  });

  it("过期码只丢 code 保 hub；无时效的码不采纳（引导文件必带 expiresAt）", () => {
    const expired = parseBootstrapJson(JSON.stringify({ hub: "https://hub.example.com", pairingCode: "AB2CD3EF", expiresAt: "2026-11-24T11:00:00.000Z" }), NOW);
    expect(expired).toEqual({ hub: "https://hub.example.com" });
    const noExpiry = parseBootstrapJson(JSON.stringify({ hub: "https://hub.example.com", pairingCode: "AB2CD3EF" }), NOW);
    expect(noExpiry).toEqual({ hub: "https://hub.example.com" });
  });

  it("坏 JSON/坏结构/坏字段整体降级为空——不抛错", () => {
    expect(parseBootstrapJson("not json", NOW)).toEqual({});
    expect(parseBootstrapJson("[]", NOW)).toEqual({});
    expect(parseBootstrapJson("null", NOW)).toEqual({});
    expect(parseBootstrapJson(JSON.stringify({ hub: 42, pairingCode: true }), NOW)).toEqual({});
    expect(parseBootstrapJson(JSON.stringify({ hub: "javascript:alert(1)" }), NOW)).toEqual({});
  });
});

describe("findBootstrapPrefill", () => {
  const NOW = Date.parse("2026-11-24T12:00:00.000Z");

  it("启动器同目录 bootstrap.json 优先；不存在则扫下载目录取最新", async () => {
    const exeDir = await mkdtemp(path.join(tmpdir(), "wizard-exe-"));
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wizard-dl-"));
    try {
      // exe 目录命中
      await writeFile(path.join(exeDir, "otter-connector-bootstrap.json"), JSON.stringify({ hub: "https://exe-dir.example.com", pairingCode: "AB2CD3EF", expiresAt: "2026-11-24T13:00:00.000Z" }));
      const local = await findBootstrapPrefill(exeDir, NOW, downloadsDir);
      expect(local.hub).toBe("https://exe-dir.example.com");
      expect(local.source).toBe(path.join(exeDir, "otter-connector-bootstrap.json"));

      // exe 目录没有 → 下载目录（带 " (1)" 后缀的重复下载也要能匹配；同名目录形态被 statSync 目录检查排除）
      await rm(path.join(exeDir, "otter-connector-bootstrap.json"));
      await mkdir(path.join(downloadsDir, "otter-connector-bootstrap-dir.json"));
      await writeFile(path.join(downloadsDir, "otter-connector-bootstrap (1).json"), JSON.stringify({ hub: "https://dl-old.example.com", expiresAt: "2026-11-24T13:00:00.000Z" }));
      await new Promise(r => setTimeout(r, 20)); // mtime 区分度
      await writeFile(path.join(downloadsDir, "otter-connector-bootstrap.json"), JSON.stringify({ hub: "https://dl-new.example.com", pairingCode: "ZZ2CD3EF", expiresAt: "2026-11-24T13:00:00.000Z" }));
      const fromDownloads = await findBootstrapPrefill(exeDir, NOW, downloadsDir);
      expect(fromDownloads.hub).toBe("https://dl-new.example.com");
      expect(fromDownloads.pairingCode).toBe("ZZ2CD3EF");
      expect(fromDownloads.source).toBe(path.join(downloadsDir, "otter-connector-bootstrap.json"));
    } finally {
      await rm(exeDir, { recursive: true, force: true });
      await rm(downloadsDir, { recursive: true, force: true });
    }
  });

  it("坏文件/空目录 → 空预填；最新文件坏 JSON 被跳过后取更早的好文件", async () => {
    const exeDir = await mkdtemp(path.join(tmpdir(), "wizard-exe-"));
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wizard-dl-"));
    try {
      expect(await findBootstrapPrefill(exeDir, NOW, downloadsDir)).toEqual({});

      await writeFile(path.join(downloadsDir, "otter-connector-bootstrap.json"), JSON.stringify({ hub: "https://good.example.com", expiresAt: "2026-11-24T13:00:00.000Z" }));
      await new Promise(r => setTimeout(r, 20));
      await writeFile(path.join(downloadsDir, "otter-connector-bootstrap (2).json"), "not-json"); // 最新的是坏文件
      const recovered = await findBootstrapPrefill(exeDir, NOW, downloadsDir);
      expect(recovered.hub).toBe("https://good.example.com");
      expect(recovered.source).toBe(path.join(downloadsDir, "otter-connector-bootstrap.json"));
    } finally {
      await rm(exeDir, { recursive: true, force: true });
      await rm(downloadsDir, { recursive: true, force: true });
    }
  });
});
