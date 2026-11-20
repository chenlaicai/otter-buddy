/**
 * 探针地址解析回归：`scripts/lib/probe-host.sh` 的两个函数。
 *
 * 为什么需要机械锁：服务监听地址可配置（缺省 127.0.0.1，可写 ::1 / 0.0.0.0），
 * 而运维脚本靠探活判断「实例是否起来了」——探针写死 IPv4 回环时，配置成 IPv6 回环的
 * 实例探活恒失败，alpha 会据此把刚起的健康进程当失败清掉（误杀健康实例）。
 * 这里直接 source 那个 shell 文件断言映射结果，改坏即红。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LIB = resolve(__dirname, "../../scripts/lib/probe-host.sh");

function run(script: string): string {
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

function probeHost(configured: string): string {
  return run(`set -euo pipefail; . "${LIB}"; probe_host_for '${configured}'`);
}

describe("probe_host_for：监听地址 → 探针主机部分", () => {
  it("缺省/通配 IPv4 用 IPv4 回环探", () => {
    expect(probeHost("")).toBe("127.0.0.1");
    expect(probeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHost("*")).toBe("127.0.0.1");
  });

  it("IPv6（含通配与带引号形态）映射成带方括号的回环", () => {
    expect(probeHost("::1")).toBe("[::1]");
    expect(probeHost("[::1]")).toBe("[::1]");
    expect(probeHost("::")).toBe("[::1]");
    expect(probeHost("[::]")).toBe("[::1]");
    expect(probeHost('"::1"')).toBe("[::1]");
  });

  it("具体地址原样透传（IPv4 / 主机名 / 非回环 IPv6）", () => {
    expect(probeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(probeHost("localhost")).toBe("localhost");
    expect(probeHost("192.168.1.5")).toBe("192.168.1.5");
    expect(probeHost("2001:db8::1")).toBe("[2001:db8::1]");
  });
});

describe("config_server_host：只读 server 段的 host", () => {
  it("取 server.host；缺省与其它段的 host 键不误读", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-host-"));
    try {
      const withHost = join(dir, "a.yaml");
      writeFileSync(withHost, "llm:\n  host: not-this\nserver:\n  port: 3000\n  host: ::1\n");
      expect(run(`set -euo pipefail; . "${LIB}"; config_server_host "${withHost}"`)).toBe("::1");

      const withoutHost = join(dir, "b.yaml");
      writeFileSync(withoutHost, "llm:\n  host: 10.0.0.1\nserver:\n  port: 3000\n");
      expect(run(`set -euo pipefail; . "${LIB}"; config_server_host "${withoutHost}"`)).toBe("");

      const missing = join(dir, "nope.yaml");
      expect(run(`set -euo pipefail; . "${LIB}"; config_server_host "${missing}"`)).toBe("");

      // 行内注释与引号形态也要能去干净
      const commented = join(dir, "c.yaml");
      writeFileSync(commented, "server:\n  host: \"127.0.0.1\"  # 本机\n");
      expect(run(`set -euo pipefail; . "${LIB}"; config_server_host "${commented}"`)).toBe("127.0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
