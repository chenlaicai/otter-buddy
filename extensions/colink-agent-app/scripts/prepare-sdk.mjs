// 从 CoLink 检出构建官方 @colink/app-sdk，并把发行包原样落到 vendor/app-sdk。
//
// Why: 0.28 起 SDK 的运行实现只有 .mts 源码，发行包需要先构建（.build → tarball）；
// 直接 cp 源码目录会拿到没有 index.mjs/types 的半成品。这里复用 CoLink 自己的
// distribution/build.mjs（权威打包路径，含版本与完整性校验），再解包到 vendor。
//
// 用法：COLINK_REPO=/path/to/colink npm run prepare:sdk
// 产物：vendor/app-sdk（与 npm 包同构）+ 根目录 sdk-pin.json（版本、完整性、CoLink 构建来源）。
// 原子性：先在 staging 校验，再一次性换位；中途失败回滚到上一份 vendor，不留 vendor 与 pin 错位。
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
// CoLink 构建来源：便于审计「这份 vendor 是从哪个 commit 出来的」。
const sourceCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pinFile = resolve(root, 'sdk-pin.json');
const backup = resolve(vendor, '.app-sdk.previous');
rmSync(backup, { recursive: true, force: true });
const hadPrevious = existsSync(target);
if (hadPrevious) execFileSync('mv', [target, backup]);
try {
  execFileSync('mv', [staging, target]);
  const pinTemporary = `${pinFile}.${process.pid}.tmp`;
  writeFileSync(pinTemporary, `${JSON.stringify({
    package: '@colink/app-sdk',
    version,
    integrity,
    builtFrom: 'dev/app-toolkit/distribution/build.mjs',
    sourceCommit,
    note: '由 npm run prepare:sdk 生成，勿手改；升级 SDK 时重跑并同步适配插件代码',
  }, null, 2)}\n`);
  execFileSync('mv', [pinTemporary, pinFile]);
} catch (error) {
  // 换位或写 pin 失败：回滚到上一份 vendor，避免插件引用半套 SDK。
  rmSync(target, { recursive: true, force: true });
  if (hadPrevious) execFileSync('mv', [backup, target]);
  throw error;
}
rmSync(backup, { recursive: true, force: true });
// tarball 只作构建中转，不留在仓库里。
rmSync(tgz, { force: true });
console.log(`CoLink SDK ${version} vendored to ${target} (source ${sourceCommit.slice(0, 8)})`);
