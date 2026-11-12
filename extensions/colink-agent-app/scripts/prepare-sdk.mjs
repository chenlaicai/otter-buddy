import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.COLINK_SDK_SOURCE;
if (!source || !existsSync(resolve(source, 'package.json'))) {
  throw new Error('COLINK_SDK_SOURCE 必须指向 @colink/app-sdk 包目录');
}
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/app-sdk');
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(resolve(source), target, {
  recursive: true,
  filter: path => !path.includes('/node_modules/') && !path.includes('/test/'),
});
console.log(`CoLink SDK copied to ${target}`);
