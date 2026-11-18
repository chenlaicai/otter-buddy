export function sourceInputs(name, text) {
    if (!/\.html?$/i.test(name))
        return { files: [{ name, source: text }], dependencies: [], diagnostics: [] };
    const files = [], dependencies = [], diagnostics = [];
    let cursor = 0, script = 0, templateDepth = 0;
    const warn = (offset, message) => diagnostics.length < 64 && diagnostics.push({ code: 'HTML_SOURCE_UNRESOLVED',
        source: name + ':' + ((text.slice(0, offset).match(/\r\n|\r|\n/g)?.length ?? 0) + 1),
        message, hint: '仅检查 HTML 内联模块与本地相对模块脚本；其他代码单独提供源码入口并执行浏览器断言，不能视为页面完整验收。' });
    while (cursor < text.length) {
        const start = text.indexOf('<', cursor);
        if (start < 0)
            break;
        if (text.startsWith('<!--', start)) {
            const end = text.indexOf('-->', start + 4);
            if (end < 0) {
                warn(start, 'HTML 注释未闭合。');
                break;
            }
            cursor = end + 3;
            continue;
        }
        const match = /^<(\/?)([a-z][a-z0-9:-]*)\b/i.exec(text.slice(start));
        if (!match) {
            cursor = start + 1;
            continue;
        }
        let end = start + match[0].length, quote;
        for (; end < text.length; end++) {
            const c = text[end];
            if (quote) {
                if (c === quote)
                    quote = undefined;
            }
            else if (c === '"' || c === "'")
                quote = c;
            else if (c === '>')
                break;
        }
        if (end === text.length) {
            warn(start, 'HTML 标签未闭合。');
            break;
        }
        cursor = end + 1;
        const tag = match[2].toLowerCase(), closing = Boolean(match[1]);
        if (tag === 'template') {
            if (!closing) {
                templateDepth++;
                warn(start, 'template 中的动态页面内容未纳入静态执行路径。');
            }
            else
                templateDepth = Math.max(0, templateDepth - 1);
            continue;
        }
        if (closing)
            continue;
        const attributes = new Map();
        const raw = text.slice(start + match[0].length, end);
        for (const attr of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            const key = attr[1].toLowerCase();
            if (attributes.has(key))
                warn(start, '重复 HTML 属性无法可靠确定脚本输入。');
            else
                attributes.set(key, attr[2] ?? attr[3] ?? attr[4] ?? '');
            if (/^on[a-z]/i.test(key))
                warn(start, 'HTML 事件属性中的代码未检查。');
            if (/^\s*javascript:/i.test(attributes.get(key) ?? ''))
                warn(start, 'HTML JavaScript URL 中的代码未检查。');
        }
        if (tag === 'base' && attributes.has('href'))
            warn(start, 'base href 会改变模块地址，须显式提供对应源码入口。');
        if (tag === 'plaintext')
            break;
        if (!['script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes'].includes(tag))
            continue;
        const close = new RegExp('</' + tag + '\\s*>', 'ig');
        close.lastIndex = cursor;
        const stop = close.exec(text);
        if (!stop) {
            warn(start, 'HTML 原始文本标签未闭合。');
            break;
        }
        const content = text.slice(cursor, stop.index), offset = cursor;
        cursor = close.lastIndex;
        if (tag !== 'script' || templateDepth)
            continue;
        if (files.length + dependencies.length >= 512) {
            warn(start, 'HTML 脚本数超过 512 个。');
            break;
        }
        const type = attributes.get('type')?.trim().toLowerCase() ?? '';
        if (type !== 'module') {
            if (!['application/json', 'application/ld+json', 'text/plain'].includes(type))
                warn(start, '非模块脚本、HTML importmap 或未知脚本类型未检查；使用显式源码入口或 --import-map。');
            continue;
        }
        if (attributes.has('href') || attributes.has('xlink:href')) {
            warn(start, '外部 SVG 脚本不会下载或执行。');
            continue;
        }
        if (attributes.has('src')) {
            const src = attributes.get('src');
            if (/^\.{1,2}\//.test(src) && !/[?#&]/.test(src))
                dependencies.push(src);
            else
                warn(start, '非本地相对地址的 script src 不会下载或执行。');
            continue;
        }
        script++;
        files.push({ name: name + '.inline-' + script + '.mjs', original: name,
            source: text.slice(0, offset).replace(/[^\r\n]/g, ' ') + content });
    }
    return { files, dependencies, diagnostics };
}
