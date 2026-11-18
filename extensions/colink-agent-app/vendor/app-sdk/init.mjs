import "./src/diagnostics/error-projection.mjs";
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const usage = 'node node_modules/@colink/app-sdk/init.mjs <event|display|user-page> [directory]';
const example = (path) => readFile(new URL('./examples/' + path, import.meta.url), 'utf8');
export async function initializeProject(kind, directory = '.') {
    if (!['event', 'display', 'user-page'].includes(kind))
        throw Error(usage);
    const registry = JSON.parse(await example('registry.json'));
    const source = registry.starters[kind].derivedFrom;
    const pkg = JSON.parse(await example(source + '/package.json'));
    pkg.name = 'my-colink-app';
    pkg.exampleBrowser = kind === 'event' ? [] : ['page.ts'];
    const files = new Map();
    for (const name of ['project.mjs', 'tsconfig.server.json', 'tsconfig.browser.json'])
        files.set(name, await example('common/' + name));
    files.set('app.env.example', await readFile(new URL('./app.env.example', import.meta.url), 'utf8'));
    let manifest = await example(source + '/manifest.ts');
    if (kind === 'event')
        manifest = manifest.replace(/,\s*EventType\.CoLinkUiActionInvoked\b/, '');
    else
        manifest = manifest.replace(/,\s*\{\s*viewId:\s*['"]color['"][^}]+\}/, '');
    if (kind !== 'event')
        manifest = manifest.replace('Permission.ProjectsList', '');
    files.set('manifest.ts', manifest);
    let code = `import {createCoLinkRuntime,serveCoLinkRuntime,EventType} from '@colink/app-sdk';
import manifest from './manifest.js';
const runtime=createCoLinkRuntime({manifest${kind === 'event' ? `,onEvent:{[EventType.UserMessageReceived]:async ctx=>{await ctx.reply({text:ctx.event.data.text});}}` : ''}});
`;
    if (kind === 'user-page')
        code += `if(!runtime.pages)throw Error('PAGES_REQUIRED');
const authenticate=runtime.pages.authenticate;
const server=await serveCoLinkRuntime(runtime,{views:{home:new URL('./index.html',import.meta.url)},assets:{'/page.js':new URL('./page.js',import.meta.url)},routes:{
 '/api/me':async(req,res)=>{const identity=await authenticate(req);res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify({userId:identity.userId}));},
}});
`;
    else
        code += `const server=await serveCoLinkRuntime(runtime${kind === 'display' ? `,{views:{home:new URL('./index.html',import.meta.url)},assets:{'/page.js':new URL('./page.js',import.meta.url)}}` : ''});\n`;
    files.set('index.ts', code + 'await server.closed;\n');
    if (kind !== 'event') {
        files.set('index.html', '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的应用</title><h1>我的应用</h1><span style="display:inline-block;background:#3366cc;width:44px;height:44px" aria-label="静态色板"></span><output>正在连接…</output><script type="module" src="./page.js"></script></html>\n');
        files.set('page.ts', kind === 'display' ? `import {connectPage} from '@colink/app-sdk/browser';
const response=await fetch('/page-config.json');if(!response.ok)throw Error('PAGE_CONFIG_UNAVAILABLE');
const config:unknown=await response.json();
if(!config||typeof config!=='object'||!('hostOrigin' in config)||typeof config.hostOrigin!=='string')throw Error('PAGE_CONFIG_INVALID');
const connection=connectPage({hostOrigin:config.hostOrigin,allowInsecureLocal:'allowInsecureLocal' in config&&config.allowInsecureLocal===true});
const context=await connection.ready;document.documentElement.style.colorScheme=context.theme;
const output=document.querySelector('output');if(output)output.textContent=new Date().toLocaleTimeString();
connection.onThemeChange(theme=>{document.documentElement.style.colorScheme=theme.theme;});
window.addEventListener('pagehide',()=>connection.close());
await connection.markPresentationReady();
` : `import {createPageClient} from '@colink/app-sdk/browser';
const page=await createPageClient(); // Connect first; identifying a user does not grant platform access.
await page.login();
const me=await page.requestBackend({path:'/api/me'});
const output=document.querySelector('output');if(output)output.textContent=JSON.stringify(me);
page.connection.onThemeChange(theme=>{document.documentElement.style.colorScheme=theme.theme;});
window.addEventListener('pagehide',()=>page.close());
`);
    }
    await mkdir(directory, { recursive: true });
    let oldPackage;
    try {
        oldPackage = await readFile(join(directory, 'package.json'), 'utf8');
    }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
    }
    if (oldPackage) {
        const previous = JSON.parse(oldPackage);
        Object.assign(pkg, previous, { type: 'module', scripts: { ...previous.scripts, ...pkg.scripts }, exampleBrowser: pkg.exampleBrowser, devDependencies: { ...previous.devDependencies, ...pkg.devDependencies } });
    }
    const created = [];
    try {
        for (const [name, text] of files) {
            const path = join(directory, name);
            await writeFile(path, text, { flag: 'wx' });
            created.push(path);
        }
        await writeFile(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', { flag: oldPackage ? 'w' : 'wx' });
    }
    catch (error) {
        for (const path of created)
            await unlink(path);
        if (oldPackage)
            await writeFile(join(directory, 'package.json'), oldPackage);
        throw error;
    }
    return [...files.keys(), 'package.json'];
}
if (import.meta.main) {
    const [kind, directory = '.', ...extra] = process.argv.slice(2);
    if (kind === '--help')
        console.log(usage);
    else if (extra.length)
        throw Error(usage);
    else
        console.log(JSON.stringify({ files: await initializeProject(kind, directory), directory, entry: 'dist/index.js', next: 'npm install && npm run typecheck && npm run build && npm start' }));
}
