import { createServer } from 'node:http';
import { CoLinkError } from "../shared/errors.mjs";
import { isRecord, errorCode } from "../shared/data.mjs";
const invalid = () => new CoLinkError('LOCAL_MCP_INVALID_OPTIONS', 400, undefined, {
    message: 'Invalid local MCP configuration.',
    hint: 'Use mcp: true or { port?, serverName? }. The SDK binds 127.0.0.1; do not set toolsOrigin in managed mode.',
});
export function localMcpOptions(mcp, toolsOrigin) {
    if (mcp === undefined || mcp === false)
        return null;
    if (mcp === true)
        mcp = {};
    if (!isRecord(mcp) ||
        Object.keys(mcp).some(key => !['port', 'serverName', 'clientName'].includes(key)) ||
        mcp.serverName !== undefined && (typeof mcp.serverName !== 'string' || !mcp.serverName.trim()))
        throw invalid();
    // Explicit handler hosting remains available to existing trusted integrations.
    if (mcp.clientName !== undefined) {
        if (typeof mcp.clientName !== 'string' || !mcp.clientName.trim() || !toolsOrigin || mcp.port !== undefined)
            throw invalid();
        return { ...mcp, managed: false, clientName: mcp.clientName };
    }
    if (toolsOrigin !== undefined || mcp.port !== undefined && (typeof mcp.port !== 'number' || !Number.isInteger(mcp.port) || mcp.port < 0 || mcp.port > 65535))
        throw invalid();
    return { ...mcp, port: mcp.port ?? 0, managed: true };
}
/** Owns only the SDK's private listener, never the public App server or framework clients. */
export function createLocalMcpServer(handler, port) {
    let server, starting, closing;
    let stopped = false, origin;
    const sockets = new Set();
    return {
        get origin() {
            if (!origin || stopped)
                throw new CoLinkError('LOCAL_MCP_NOT_STARTED', 503, undefined, {
                    message: 'Local MCP server is not running.', hint: 'Await app.start() or start the Agent with serveCoLinkRuntime before accepting work.',
                });
            return origin;
        },
        start() {
            if (stopped)
                return Promise.reject(new CoLinkError('LOCAL_MCP_CLOSED', 409));
            if (starting)
                return starting;
            server = createServer(handler);
            server.requestTimeout = 20000;
            server.headersTimeout = 10000;
            server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
            server.on('upgrade', (_req, socket) => socket.destroy());
            const current = server;
            starting = new Promise((resolve, reject) => {
                current.once('error', reject);
                current.listen(port, '127.0.0.1', () => {
                    const address = current.address();
                    if (!address || typeof address === 'string') {
                        reject(new CoLinkError('LOCAL_MCP_NOT_STARTED', 503));
                        return;
                    }
                    origin = `http://127.0.0.1:${address.port}`;
                    resolve();
                });
            });
            return starting;
        },
        close() {
            if (closing)
                return closing;
            stopped = true;
            closing = (async () => {
                // A concurrent start must settle before closing its listener.
                await starting?.catch(() => { });
                const current = server;
                if (!current)
                    return;
                const closed = new Promise((resolve, reject) => current.close(error => {
                    if (error && errorCode(error) !== 'ERR_SERVER_NOT_RUNNING')
                        reject(error);
                    else
                        resolve();
                }));
                for (const socket of sockets)
                    socket.destroy();
                await closed;
            })();
            return closing;
        },
    };
}
