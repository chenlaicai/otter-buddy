import { isRecord } from "../shared/data.mjs";
import { parseMessageMentions } from "../shared/message-mention-schema.mjs";
const strings = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');
const optionalText = (value) => value === undefined || value === null || typeof value === 'string';
export function isMessageContent(value) {
    if (!isRecord(value) || !isRecord(value.author))
        return false;
    return (value.author.type === 'user' || value.author.type === 'agent' || value.author.type === 'app') && typeof value.author.id === 'string' && typeof value.author.name === 'string' &&
        typeof value.text === 'string' && typeof value.createdAt === 'string' && typeof value.recalled === 'boolean' &&
        Array.isArray(value.files) && value.files.every(file => isRecord(file) && typeof file.fileId === 'string' && typeof file.fileName === 'string') &&
        (value.mentions === undefined || parseMessageMentions(value.mentions) !== undefined);
}
export function isBackgroundGrant(value) {
    return isRecord(value) && typeof value.grantId === 'string' && typeof value.installationId === 'string' && typeof value.userId === 'string' &&
        (value.projectId === null || typeof value.projectId === 'string') && strings(value.scopes) &&
        typeof value.version === 'number' && typeof value.authorizationVersion === 'number' && (value.status === 'active' || value.status === 'inactive');
}
export function isPageIdentity(value) {
    return isRecord(value) && typeof value.sessionId === 'string' && typeof value.authorizationVersion === 'number' &&
        typeof value.userId === 'string' && typeof value.installationId === 'string' && typeof value.pageSessionId === 'string' &&
        isRecord(value.source) && strings(value.scopes) && typeof value.expiresAt === 'string' &&
        optionalText(value.username) && optionalText(value.displayName) &&
        (value.content === undefined || isMessageContent(value.content)) && (value.viewData === undefined || isRecord(value.viewData)) &&
        (value.backgroundGrant === undefined || isBackgroundGrant(value.backgroundGrant));
}
/** Display context only. This decoder does not establish identity or authority. */
export function pageContext(value) {
    if (!isRecord(value) || !isRecord(value.source) || typeof value.container !== 'string' ||
        (value.theme !== 'light' && value.theme !== 'dark') || typeof value.themeId !== 'string' || typeof value.language !== 'string' ||
        !strings(value.availableMethods) || value.content !== undefined && !isMessageContent(value.content) ||
        value.viewData !== undefined && !isRecord(value.viewData))
        return undefined;
    return { ...value, source: value.source, container: value.container, theme: value.theme, themeId: value.themeId,
        language: value.language, availableMethods: value.availableMethods, readingForeground: value.readingForeground === true,
        ...(isMessageContent(value.content) ? { content: value.content } : {}), ...(isRecord(value.viewData) ? { viewData: value.viewData } : {}) };
}
