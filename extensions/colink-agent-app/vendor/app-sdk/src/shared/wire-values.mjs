import { isRecord } from "./data.mjs";
import { fail } from "./errors.mjs";
import { methodSchemas, resultSchemas } from "./wire-schemas.mjs";
export function isWireValue(value, index, schemas, depth = 0) {
    if (depth > 100)
        return false;
    const schema = schemas[index];
    const valid = (v, id, nextDepth) => isWireValue(v, id, schemas, nextDepth);
    switch (schema.kind) {
        case 'unknown': return true;
        case 'never': return false;
        case 'undefined': return value === undefined;
        case 'string': return typeof value === 'string';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'literal': return value === schema.value;
        case 'bytes': return value instanceof Uint8Array;
        case 'array': return Array.isArray(value) && value.every(v => valid(v, schema.item, depth + 1));
        case 'tuple': return Array.isArray(value) && value.length === schema.items.length && schema.items.every((id, i) => valid(value[i], id, depth + 1));
        case 'union': return schema.members.some(id => valid(value, id, depth + 1));
        case 'intersection': return schema.members.every(id => valid(value, id, depth + 1));
        case 'object': return isRecord(value) && Object.entries(schema.fields).every(([key, field]) => field.optional && value[key] === undefined || valid(value[key], field.schema, depth + 1)) &&
            (schema.values === undefined || Object.values(value).every(v => valid(v, schema.values, depth + 1)));
    }
}
/** The sole DTO assertion follows a complete schema generated from the checked return type. */
export function businessResult(method, value) {
    if (!isWireValue(value, methodSchemas[method], resultSchemas))
        throw fail('PLATFORM_RESPONSE_INVALID', 502);
    return value;
}
