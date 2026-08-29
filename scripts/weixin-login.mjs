#!/usr/bin/env node
/**
 * 微信扫码登录 CLI（issue #565）。
 *
 * 用法：npm run weixin:login
 * 流程：申请二维码 → 终端渲染（qrcode-terminal）→ 长轮询扫码状态 →
 * confirmed 落 bot_token 到 data/weixin/accounts.json → 提示重启服务。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// 终端二维码渲染（协议插件同款依赖）
import qrcode from "qrcode-terminal";

async function main() {
  // 读 config.yaml 拿 weixin 段（不引 config-service 避免其校验副作用，裸读 yaml 子集）
  const configPath = path.resolve(process.cwd(), "config/config.yaml");
  let baseUrl = "https://ilinkai.weixin.qq.com";
  let stateDir = "./data/weixin";
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    const baseMatch = raw.match(/^\s*baseUrl:\s*(\S+)\s*$/m);
    // 简易解析：只在本文件无 yaml 依赖的前提下取 weixin: 段下的 baseUrl/stateDir
    const weixinBlock = raw.split(/^weixin:/m)[1]?.split(/^\S/m)[0] ?? "";
    if (weixinBlock) {
      const b = weixinBlock.match(/^\s*baseUrl:\s*(\S+)\s*$/m);
      const s = weixinBlock.match(/^\s*stateDir:\s*(\S+)\s*$/m);
      if (b) baseUrl = b[1];
      if (s) stateDir = s[1];
    }
    if (baseMatch && !weixinBlock) baseUrl = baseMatch[1]; // 兜底：顶层 baseUrl（无 weixin 段）
  }

  const { WeixinApiClient } = await import("../dist/src/frameworks/weixin/api-client.js");
  const { WeixinAccountStore } = await import("../dist/src/frameworks/weixin/account-store.js");
  const { WeixinLoginFlow } = await import("../dist/src/frameworks/weixin/login-flow.js");

  const logger = {
    info: (m: string) => console.log(`[weixin-login] ${m}`),
    warn: (m: string) => console.warn(`[weixin-login] ${m}`),
    error: (m: string) => console.error(`[weixin-login] ${m}`),
    debug: () => {},
  };
  const accountStore = new WeixinAccountStore({ stateDir });
  const api = new WeixinApiClient({ baseUrl });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askVerifyCode = () =>
    new Promise((resolve) => rl.question("请输入微信提示的配对码: ", (a) => resolve(a.trim())));

  const flow = new WeixinLoginFlow({
    api,
    accountStore,
    onQrCode: (qrUrl) => {
      console.log("\n请用微信扫码：\n");
      qrcode.generate(qrUrl, { small: true });
      console.log(`（或打开链接：${qrUrl}）`);
    },
    onStatus: (s) => console.log(`[status] ${s}`),
    verifyCodeInput: askVerifyCode,
    logger: logger as never,
  });

  try {
    const { accountId, ilinkUserId } = await flow.run();
    console.log(`\n✅ 登录成功！账号 ${accountId} 已保存（ilinkUserId: ${ilinkUserId}）。`);
    console.log(`   重启 otter-buddy 后微信通道自动拉起（config.yaml 的 weixin 段保持/添加：`);
    console.log(`   weixin:\n     stateDir: ${stateDir}${ilinkUserId ? `\n     partnerUserId: ${ilinkUserId}` : ""}）`);
    if (ilinkUserId) console.log(`   partnerUserId 建议填 ${ilinkUserId}（命令门禁锚定）`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ 登录失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
