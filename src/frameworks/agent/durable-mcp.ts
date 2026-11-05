import fs from "node:fs";
import path from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { Logger } from "@usecases/ports/logger";
import type { McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";

/** Public MCP configuration accepted by the native durable bridge. */
export function readMcpEntries(raw: unknown): McpServerEntry[] {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const servers = value.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers).map(([name, config]) => ({ name, config: config as McpServerConfig, scope: "global", source: "mcp.json" }));
}

class Connection {
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private closed = false;
  tools: Awaited<ReturnType<McpClient["listTools"]>> = [];
  instructions?: string;
  hasResources = false;
  constructor(readonly entry: McpServerEntry, private readonly cwd: string, private readonly logger: Logger) {}
  async connect(signal?: AbortSignal): Promise<McpClient> {
    if (this.closed) throw new Error("MCP connection is closed");
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const config = this.entry.config;
      const transport = "url" in config
        ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
        : new StdioTransport({ command: config.command, args: config.args, cwd: config.cwd ?? this.cwd, env: config.env });
      const client = new McpClient({ name: "otter-buddy", version: "1.5.0", roots: [{ uri: `file://${this.cwd}`, name: "conversation workspace" }] });
      client.onClose(() => { this.client = undefined; });
      try {
        await client.connect(transport);
        this.client = client;
        this.tools = await client.listTools({ signal });
        this.instructions = client.instructions;
        this.hasResources = client.serverCapabilities?.resources !== undefined;
        return client;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  async ready(signal?: AbortSignal): Promise<void> { await this.connect(signal); }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return (await this.connect(signal)).callTool(name, args, { signal, timeoutMs: (this.entry.config.timeout ?? 60) * 1000 });
  }
  async readResource(uri: string, signal?: AbortSignal) { return (await this.connect(signal)).readResource(uri, { signal }); }
  async listResources(signal?: AbortSignal) { return (await this.connect(signal)).listResources({ signal }); }
  async close(): Promise<void> { this.closed = true; await this.client?.close(); this.client = undefined; }
}

function toolName(server: string, tool: string, used: Set<string>): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  let name = `mcp__${safe(server)}__${safe(tool)}`;
  let index = 2;
  while (used.has(name)) name = `mcp__${safe(server)}_${index++}__${safe(tool)}`;
  used.add(name);
  return name;
}

export async function readMcpConfigFiles(cwd: string, agentPath: string): Promise<McpServerEntry[]> {
  const entries: McpServerEntry[] = [];
  for (const file of [agentPath, path.join(cwd, "mcp.json")]) {
    try { entries.push(...readMcpEntries(JSON.parse(await fs.promises.readFile(file, "utf8")))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid MCP config ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  return entries.filter((entry, index) => entries.findIndex(other => other.name === entry.name) === index);
}

/** Native MCP client lifecycle; no coding-agent AgentSession is created. */
export class DurableMcpBridge {
  private readonly connections: Connection[];
  constructor(entries: McpServerEntry[], cwd: string, private readonly logger: Logger) {
    this.connections = entries.filter(entry => entry.config.enabled !== false).map(entry => new Connection(entry, cwd, logger));
  }
  async registrations(signal?: AbortSignal): Promise<ToolRegistration[]> {
    const result: ToolRegistration[] = [];
    const used = new Set<string>();
    for (const connection of this.connections) {
      await connection.ready(signal);
      for (const tool of connection.tools) {
        const config = connection.entry.config;
        const exposure = config.toolExposure?.[tool.name] ?? config.exposure ?? "codemode";
        if (exposure === "hidden") continue;
        const name = toolName(connection.entry.name, tool.name, used);
        result.push(defineTool<any>({
          name,
          description: `[MCP ${connection.entry.name}] ${tool.description ?? tool.name}`,
          parameters: (tool.inputSchema ?? { type: "object" }) as object,
          replay: "unsafe",
          deferred: exposure === "direct" ? undefined : true,
          execute: async (args, _api, context) => {
            const raw = await connection.callTool(tool.name, args, context.abortSignal);
            const content = (raw.content ?? []).map(block => block.type === "text" ? { type: "text" as const, text: block.text } : { type: "text" as const, text: JSON.stringify(block) });
            return { output: content, structuredOutput: raw.structuredContent as never, details: raw as never, isError: raw.isError ?? false };
          },
        }));
      }
      if (connection.hasResources) {
        result.push(defineTool<any>({
          name: toolName(connection.entry.name, "read_resource", used), description: "Read an MCP resource by URI", replay: "unsafe",
          parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
          execute: async (args, _api, context) => {
            const response = await connection.readResource(args.uri, context.abortSignal);
            return { output: [{ type: "text", text: JSON.stringify(response.contents) }], details: response as never };
          },
        }));
      }
    }
    return result;
  }
  instructions(): string { return this.connections.map(c => c.instructions ? `${c.entry.name}: ${c.instructions}` : "").filter(Boolean).join("\n"); }
  async close(): Promise<void> { await Promise.all(this.connections.map(connection => connection.close())); }
}
