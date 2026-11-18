import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CoLinkError } from "./errors.mjs";
import { isRecord, errorCode } from "./data.mjs";
function stateDocument(value) {
    if (!isRecord(value) || value.format !== 2 || !isRecord(value.events) || !isRecord(value.sessions))
        throw Error('Unsupported state format');
    return { ...value, format: 2, events: value.events, sessions: value.sessions };
}
const keyError = (code, message, hint) => new CoLinkError(code, 503, undefined, { message, hint });
function readManagedKey(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size < 64 || stat.size > 66)
            throw keyError('STORAGE_KEY_INVALID', '本地存储密钥文件格式无效。', '恢复原来的 .key 文件；不要为已有状态重新生成密钥。');
        const text = readFileSync(fd, 'utf8');
        if (!/^[a-f0-9]{64}(?:\r?\n)?$/i.test(text))
            throw keyError('STORAGE_KEY_INVALID', '本地存储密钥文件格式无效。', '恢复原来的 .key 文件；不要为已有状态重新生成密钥。');
        return text.trim().toLowerCase();
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        if (error instanceof CoLinkError)
            throw error;
        throw keyError('STORAGE_KEY_UNAVAILABLE', '无法读取本地存储密钥文件。', '检查状态目录与 .key 文件的访问权限，保留原文件后重试。');
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
// Called only after acquiring the state file's exclusive lock. Never rotate or overwrite keys.
function storageKey(file, supplied) {
    const path = file + '.key', existing = readManagedKey(path);
    if (supplied !== undefined) {
        if (existing !== undefined && existing !== supplied.toLowerCase())
            throw keyError('STORAGE_KEY_MISMATCH', '显式密钥与本地持久密钥不一致。', '使用同一个原密钥，或恢复匹配的状态文件与 .key 文件；SDK 不自动轮换密钥。');
        return supplied;
    }
    if (existing !== undefined)
        return existing;
    if (existsSync(file) || existsSync(file + '.tmp'))
        throw keyError('STORAGE_KEY_MISSING', '已有状态，但缺少对应的本地存储密钥。', '恢复原 .key 文件；原先使用显式密钥的部署应继续注入该密钥，不能为已有状态生成新密钥。');
    const generated = randomBytes(32).toString('hex');
    try {
        writeFileSync(path, generated + '\n', { flag: 'wx', mode: 0o600, flush: true });
    }
    catch {
        throw keyError('STORAGE_KEY_UNAVAILABLE', '无法持久化首次生成的存储密钥。', '检查状态目录的写权限与可用空间；保留已有文件，不覆盖或重建密钥。');
    }
    return generated;
}
export function openEncryptedStore(file, keyHex, { aad = 'colink-agent-state-v1', decode = stateDocument } = {}) {
    if (keyHex !== undefined && (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(keyHex)))
        throw Error('COLINK_CREDENTIAL_KEY must contain 32 bytes in hex');
    file = resolve(file);
    let key;
    if (typeof aad !== 'string' || !aad)
        throw Error('Store AAD is required');
    const associatedData = Buffer.from(aad);
    const seal = (value) => {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(associatedData);
        return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    };
    const unseal = (value) => {
        const bytes = Buffer.from(value, 'base64');
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAAD(associatedData);
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    };
    mkdirSync(dirname(file), { recursive: true });
    const lock = file + '.lock';
    const fd = openSync(lock, 'wx', 0o600);
    let data;
    try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flush: true });
        key = Buffer.from(storageKey(file, keyHex), 'hex');
        const raw = existsSync(file) ? JSON.parse(unseal(readFileSync(file, 'utf8'))) :
            { format: 2, events: {}, sessions: {}, oauthInstallations: {}, oauthUserExecutions: {} };
        data = decode(stateDocument(raw));
    }
    catch (error) {
        closeSync(fd);
        unlinkSync(lock);
        throw error;
    }
    let closed = false;
    return {
        data, seal, unseal,
        persist() {
            if (closed)
                throw Error('Store closed');
            const json = JSON.stringify(data);
            if (Buffer.byteLength(json) > 16 * 1024 * 1024)
                throw Object.assign(Error('State capacity reached'), { code: 'STORAGE_LIMIT', status: 503 });
            writeFileSync(file + '.tmp', seal(json), { mode: 0o600, flush: true });
            renameSync(file + '.tmp', file);
        },
        close() { if (!closed) {
            closed = true;
            closeSync(fd);
            unlinkSync(lock);
        } },
    };
}
