import { MANIFEST_SCOPES } from "./public-contract.mjs";
const scopes = MANIFEST_SCOPES;
// Explicit inclusions come from the generated platform registry, never scope names.
export function hasScopes(granted, required) {
    return required.every(scope => granted.includes(scope) ||
        granted.some(parent => scopes[parent]?.includes?.includes(scope)));
}
