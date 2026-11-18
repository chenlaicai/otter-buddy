/** Pure data completion shared by the SDK and offline tools supplied explicit SDK data. */
export function completeManifest(input, defaults) {
    const result = structuredClone(input);
    function fill(node, parts, value) {
        if (parts[0] === '*') {
            if (Array.isArray(node))
                for (const item of node)
                    fill(item, parts.slice(1), value);
            return;
        }
        if (!node || typeof node !== 'object' || Array.isArray(node))
            return;
        const record = node, [key, ...rest] = parts;
        if (!rest.length) {
            // Explicit declarations still go through the real protocol validator; do not mask errors.
            if (record[key] === undefined)
                record[key] = value;
        }
        else if (Object.hasOwn(record, key))
            fill(record[key], rest, value);
    }
    for (const [path, value] of Object.entries(defaults))
        fill(result, path.split('.'), value);
    return result;
}
