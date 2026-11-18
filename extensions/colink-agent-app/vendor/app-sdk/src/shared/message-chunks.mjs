import { fail } from "./errors.mjs";
// Platform limits are UTF-16 units. Never cut a surrogate pair, a structured
// mention or a colink-ui card; validate the entire operation before sending.
export function messageChunks(text, mentions) {
    if (typeof text !== 'string' || text.length > 64000)
        throw fail('VALIDATION_FAILED', 400);
    text = text.trim();
    const protectedRanges = [...(mentions?.items || [])];
    for (const match of text.matchAll(/```colink-ui[^\n]*\n[\s\S]*?```/g))
        protectedRanges.push({ start: match.index, end: match.index + match[0].length });
    if (protectedRanges.some(r => r.end - r.start > 4000))
        throw fail('VALIDATION_FAILED', 400);
    const chunks = [];
    for (let start = 0; start < text.length;) {
        let end = Math.min(start + 4000, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]))
            end--;
        const crossed = protectedRanges.filter(r => r.start < end && r.end > end);
        if (crossed.length)
            end = Math.min(...crossed.map(r => r.start));
        if (end <= start)
            throw fail('VALIDATION_FAILED', 400);
        const raw = text.slice(start, end), part = raw.trim(), offset = start + raw.length - raw.trimStart().length;
        if (part)
            chunks.push({ text: part, ...(mentions ? { mentions: { version: mentions.version,
                        items: mentions.items.filter(r => r.start >= offset && r.end <= offset + part.length)
                            .map(r => ({ ...r, start: r.start - offset, end: r.end - offset })) } } : {}) });
        start = end;
    }
    return chunks.length ? chunks : [{ text: '', ...(mentions ? { mentions } : {}) }];
}
export const splitText = (text) => messageChunks(text).map(part => part.text).filter(Boolean);
