import { explainMethodError } from "../diagnostics/method-diagnostics.mjs";
import { METHOD_GUIDES } from "../diagnostics/method-guides.mjs";
import { HTTP_ROUTES } from "../shared/public-contract.mjs";
import { isIterable } from "../shared/data.mjs";
const guides = METHOD_GUIDES;
const routes = HTTP_ROUTES;
export function identityMethods(methods, identity, { active = () => { } } = {}) {
    function select(value, path = '') {
        const result = {};
        for (const [name, entry] of Object.entries(value)) {
            const member = entry;
            const method = path ? path + '.' + name : name;
            if (typeof member !== 'function') {
                if (member === null || typeof member !== 'object')
                    throw new TypeError('Invalid internal method tree');
                const nested = select(member, method);
                if (Object.keys(nested).length)
                    result[name] = nested;
                continue;
            }
            const guide = guides[method], route = routes[guide?.route];
            const policies = guide?.operation ? [route?.readPolicies?.[guide.operation]] : [route?.policy, ...(route?.alternatives || [])];
            if (policies.some(p => p?.tokens.includes(identity))) {
                const explain = (error) => explainMethodError(error, identity + '.' + method, undefined, identity, undefined);
                result[name] = method.endsWith('.iterate') ? async function* (...args) {
                    try {
                        await active();
                        const values = Reflect.apply(member, undefined, args);
                        if (!isIterable(values))
                            throw new TypeError('Invalid internal iterator');
                        for await (const item of values) {
                            await active();
                            yield item;
                        }
                    }
                    catch (error) {
                        throw explain(error);
                    }
                } : async (...args) => {
                    try {
                        await active();
                        return await Reflect.apply(member, undefined, args);
                    }
                    catch (error) {
                        throw explain(error);
                    }
                };
            }
        }
        return Object.freeze(result);
    }
    // Runtime route policies perform this projection; bidirectional contract tests
    // verify the same public keys and identities against the declared client types.
    return select(methods);
}
