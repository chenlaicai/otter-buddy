// 从 CoLink 检出构建官方 @colink/app-sdk，并把发行包原样落到 vendor/app-sdk。
//
// Why: 0.28 起 SDK 的运行实现只有 .mts 源码，发行包需要先构建（.build → tarball）；
// 直接 cp 源码目录会拿到没有 index.mjs/types 的半成品。这里复用 CoLink 自己的
// distribution/build.mjs（权威打包路径，含版本与完整性校验），再解包到 vendor。
//
// 用法：COLINK_REPO=/path/to/colink npm run prepare:sdk
// 产物：vendor/app-sdk（与 npm 包同构）、vendor/colink-app-sdk-<version>.tgz、vendor/SDK-SOURCE.json
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const vendor = resolve(root, 'vendor');
const target = resolve(vendor, 'app-sdk');

const repo = process.env.COLINK_REPO ?? process.env.COLINK_SDK_SOURCE?.replace(/\/dev\/app-toolkit\/sdk\/javascript\/?$/, '');
if (!repo || !existsSync(resolve(repo, 'dev/app-toolkit/distribution/build.mjs'))) {
  throw new Error('COLINK_REPO 必须指向 CoLink 检出根目录（含 dev/app-toolkit/distribution/build.mjs）');
}

const { buildSdkArchive } = await import(pathToFileURL(resolve(repo, 'dev/app-toolkit/distribution/build.mjs')).href);
const archive = await buildSdkArchive();
const version = archive.release?.version;
if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('COLINK_SDK_VERSION_INVALID');
const integrity = `sha512-${createHash('sha512').update(archive.bytes).digest('base64')}`;

mkdirSync(vendor, { recursive: true });
const tgz = resolve(vendor, `colink-app-sdk-${version}.tgz`);
writeFileSync(tgz, archive.bytes);
// Why: 先解到临时目录再改名，避免构建失败留下半套 vendor。
const staging = resolve(vendor, '.app-sdk.staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync('tar', ['-xzf', tgz, '-C', staging, '--strip-components=1'], { stdio: 'inherit' });
const built = JSON.parse(readFileSync(resolve(staging, 'package.json'), 'utf8'));
if (built.name !== '@colink/app-sdk' || built.version !== version) throw new Error('COLINK_SDK_PACKAGE_MISMATCH');
for (const file of ['index.mjs', 'types/entries/index.d.ts', 'manifest-protocol.json']) {
  if (!existsSync(resolve(staging, file))) throw new Error(`COLINK_SDK_PACKAGE_INCOMPLETE: 缺少 ${file}`);
}
// 发行包里的 examples 只用于平台侧演示，插件不需要；入库前剔除以免仓库膨胀。
rmSync(resolve(staging, 'examples'), { recursive: true, force: true });
rmSync(target, { recursive: true, force: true });
execFileSync('mv', [staging, target]);
// tarball 只作审计锚点，真实依赖仍是 vendor/app-sdk 目录。
rmSync(tgz, { force: true });
writeFileSync(resolve(root, 'sdk-pin.json'), `${JSON.stringify({
  package: '@colink/app-sdk',
  version,
  integrity,
  builtFrom: 'dev/app-toolkit/distribution/build.mjs',
  note: '由 npm run prepare:sdk 生成，勿手改；升级 SDK 时重跑并同步适配插件代码',
}, null, 2)}\n`);
console.log(`CoLink SDK ${version} vendored to ${target}`);
