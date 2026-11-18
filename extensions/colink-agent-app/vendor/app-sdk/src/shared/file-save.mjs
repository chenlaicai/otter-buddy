// Generated from the host file-save contract; do not edit.
/** Wire contract shared by the host, SDK snapshot and Playground. No URLs or credentials. */
export const FILE_SAVE_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_SAVE_CONFIRM_MS = 5 * 60 * 1000;
export function parseFileSave(input) {
    const fail = () => { throw Object.assign(new Error('INVALID_FILE_SAVE'), { code: 'INVALID_FILE_SAVE' }); };
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['fileName', 'blob'].includes(key)))
        return fail();
    const { fileName, blob } = input;
    if (typeof fileName !== 'string' || !fileName.length || fileName.length > 200 || fileName.trim() !== fileName ||
        fileName === '.' || fileName === '..' || /[/\\:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(fileName) ||
        !(blob instanceof Blob) || blob.size > FILE_SAVE_MAX_BYTES)
        return fail();
    return { fileName, blob };
}
