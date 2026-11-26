/**
 * upload_device_file 工具测试（显式上传通道）。
 *
 * 三层数据边界的显式通道：设备/本地文件经对话执行机 env（与 DurableSession 同链路）
 * 流式读出，落既有中枢附件管线（内容寻址 + 去重 + 尺寸闸）。
 *
 * 验证：
 * - 本地 env：字节一致 + 中枢可寻址（storageRoot 下 filePath 字节 == 原件）
 * - 远端 env（真 loopback 回环）：设备原件保留、中枢副本字节一致（hub 与设备路径分离）
 * - 文件不存在 → 明确错误（isError）
 * - 尺寸超附件上限 → 明确错误
 * - 注册条件：双依赖缺一不注册（旧装配零变化）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import { createUploadDeviceFileTool } from '@interface-adapters/agent-runtime/tools/upload-device-file';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { OtterToolClient } from '@usecases/ports/otter-tool-client';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { AttachmentUploadService } from '@usecases/conversation/attachment-upload-service';
import { SqliteAttachmentRepository } from '@frameworks/db/attachment/sqlite-attachment-repository';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createRemoteLoopback } from '../../../../tests/helpers/remote-loopback';
import { createTestDb } from '../../../../tests/helpers/db';
import { createTestLogger } from '../../../../tests/helpers/logger';

const logger = createTestLogger();

/** 每用例独立临时目录，afterEach 清理 */
const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'upload-device-file-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** 真实附件上传管线（内存库 + 临时存储根） */
async function makeAttachmentUploader(opts: { maxDocumentBytes?: number } = {}) {
  const storageRoot = await makeTempDir();
  const db = createTestDb();
  const repo = new SqliteAttachmentRepository(db);
  const service = new AttachmentUploadService(repo, {
    storageRoot,
    maxImageBytes: 10 * 1024 * 1024,
    maxDocumentBytes: opts.maxDocumentBytes ?? 20 * 1024 * 1024,
  }, logger);
  return { service, storageRoot, repo };
}

function makeToolContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    client: {} as unknown as OtterToolClient,
    otterId: 'otter-1',
    conversationId: 'conv-1',
    currentMessageId: 'msg-1',
    // 统一注册制：machine 必选 gate 的池数据源（node-a 恒在线）
    listExecutionMachines: async () => ({ machines: [{ id: 'node-a', name: '中枢本机', online: true, lastSeenAt: null }] }),
    ...overrides,
  };
}

/** 执行工具并返回解析后的 JSON 文本（成功路径） */
async function runTool(tool: ReturnType<typeof createUploadDeviceFileTool>, params: Record<string, unknown>) {
  const response = await tool.execute('call-1', params);
  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  return { response, text };
}

describe('upload_device_file（显式上传通道）', () => {
  it('本地 env：字节一致 + 中枢可寻址（附件存储持有副本）', async () => {
    const workDir = await makeTempDir();
    const { service, storageRoot } = await makeAttachmentUploader();
    const env = new NodeExecutionEnv({ cwd: workDir });

    // 待上传文件：多 chunk 文本内容（>64KB，验证流式分块重组字节一致）
    const payload = Buffer.concat([
      Buffer.from('# 构建报告\n\nhello otter\n'),
      Buffer.from('x'.repeat(64 * 1024)),
      Buffer.from('\n尾行 tail'),
    ]);
    const filePath = path.join(workDir, 'report.md');
    await writeFile(filePath, payload);

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const tool = createUploadDeviceFileTool(ctx);
    const { response, text } = await runTool(tool, { machine: 'node-a', filePath, originalName: 'report.md' });

    expect(response.isError).toBeFalsy();
    const meta = JSON.parse(text) as { id: string; sizeBytes: number; sha256: string; filePath: string };
    expect(meta.sizeBytes).toBe(payload.length);

    // 中枢可寻址副本：附件存储路径存在且字节一致
    const stored = await readFile(path.join(storageRoot, meta.filePath));
    expect(stored.equals(payload)).toBe(true);

    // 显式上传 = 复制语义：原件仍在原地（不是移动）
    await expect(readFile(filePath)).resolves.toBeTruthy();
  });

  it('任意二进制（非附件白名单 kind）→ 明确拒绝——复用既有附件存储的 kind 边界，不盲扩存储语义', async () => {
    const workDir = await makeTempDir();
    const { service } = await makeAttachmentUploader();
    const env = new NodeExecutionEnv({ cwd: workDir });
    const filePath = path.join(workDir, 'artifact.bin');
    await writeFile(filePath, Buffer.alloc(256, 7));

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const tool = createUploadDeviceFileTool(ctx);
    const { response, text } = await runTool(tool, { machine: 'node-a', filePath, originalName: 'artifact.bin' });

    expect(response.isError).toBe(true);
    expect(text).toContain('不支持的文件类型');
  });

  it('远端 env（真 loopback）：设备原件保留、中枢副本字节一致——hub 与设备路径分离', async () => {
    const stack = await createRemoteLoopback();
    try {
      const { service, storageRoot } = await makeAttachmentUploader();
      const deviceWorkspace = await stack.deviceWorkspaceGateway.getWorkspacePath('conv-1');
      await mkdir(deviceWorkspace, { recursive: true });
      const payload = Buffer.from('device-side build output\n二行');
      const deviceFile = path.join(deviceWorkspace, 'dist-output.txt');
      await writeFile(deviceFile, payload);

      const env = await stack.machine.createExecutionEnvironment(deviceWorkspace, 'conv-1');
      const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
      const tool = createUploadDeviceFileTool(ctx);
      const { response, text } = await runTool(tool, { machine: 'node-a', filePath: deviceFile });

      expect(response.isError).toBeFalsy();
      const meta = JSON.parse(text) as { sizeBytes: number; filePath: string };
      expect(meta.sizeBytes).toBe(payload.length);
      const stored = await readFile(path.join(storageRoot, meta.filePath));
      expect(stored.equals(payload)).toBe(true);
      // 设备原件不动
      await expect(readFile(deviceFile)).resolves.toBeTruthy();
    } finally {
      await stack.cleanup();
    }
  });

  it('文件不存在 → 明确错误（设备侧 not_found 分类透出）', async () => {
    const workDir = await makeTempDir();
    const { service } = await makeAttachmentUploader();
    const env = new NodeExecutionEnv({ cwd: workDir });

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const tool = createUploadDeviceFileTool(ctx);
    const { response, text } = await runTool(tool, { machine: 'node-a', filePath: path.join(workDir, 'no-such-file.txt') });

    expect(response.isError).toBe(true);
    expect(text).toContain('打开文件失败');
  });

  it('尺寸超附件上限 → 明确错误（既有管线闸生效）', async () => {
    const workDir = await makeTempDir();
    const { service } = await makeAttachmentUploader({ maxDocumentBytes: 16 });
    const env = new NodeExecutionEnv({ cwd: workDir });
    const filePath = path.join(workDir, 'big.bin');
    await writeFile(filePath, Buffer.alloc(1024, 1));

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const tool = createUploadDeviceFileTool(ctx);
    const { response, text } = await runTool(tool, { machine: 'node-a', filePath });

    expect(response.isError).toBe(true);
    expect(text).toContain('上传失败');
  });

  it('resolveExecutionEnv 抛错（如设备离线）→ 明确错误', async () => {
    const { service } = await makeAttachmentUploader();
    const ctx = makeToolContext({
      attachmentUpload: service,
      resolveExecutionEnv: async () => { throw new Error('设备离线'); },
    });
    const tool = createUploadDeviceFileTool(ctx);
    const { response, text } = await runTool(tool, { machine: 'node-a', filePath: '/any' });

    expect(response.isError).toBe(true);
    expect(text).toContain('解析执行机失败');
  });
});

describe('upload_device_file 读器句柄收尾（检视回归：任何出口都显式 close）', () => {
  /** 包装本地 env 的 openBinaryReader，观测返回 reader 的 close 次数 */
  function spyReaderClose(env: ExecutionEnv) {
    let closes = 0;
    const origOpen = env.openBinaryReader.bind(env);
    env.openBinaryReader = (async (target: string, options: { noFollow?: boolean } | undefined, context: unknown) => {
      const opened = await origOpen(target, options, context as never);
      if (opened.ok) {
        const reader = opened.value;
        const origClose = reader.close.bind(reader);
        reader.close = async (ctx: never) => { closes += 1; await origClose(ctx); };
      }
      return opened;
    }) as ExecutionEnv['openBinaryReader'];
    return { closes: () => closes };
  }

  it('本地成功上传 → reader.close 恰好 1 次', async () => {
    const workDir = await makeTempDir();
    const { service } = await makeAttachmentUploader();
    const env = new NodeExecutionEnv({ cwd: workDir });
    const spy = spyReaderClose(env);
    const filePath = path.join(workDir, 'note.md');
    await writeFile(filePath, '# hi');

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const { response } = await runTool(createUploadDeviceFileTool(ctx), { machine: 'node-a', filePath });

    expect(response.isError).toBeFalsy();
    expect(spy.closes()).toBe(1);
  });

  it('本地上传被尺寸闸拒绝（失败出口）→ reader.close 仍被调用，不泄漏', async () => {
    const workDir = await makeTempDir();
    const { service } = await makeAttachmentUploader({ maxDocumentBytes: 16 });
    const env = new NodeExecutionEnv({ cwd: workDir });
    const spy = spyReaderClose(env);
    const filePath = path.join(workDir, 'big.md');
    await writeFile(filePath, 'x'.repeat(1024));

    const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
    const { response } = await runTool(createUploadDeviceFileTool(ctx), { machine: 'node-a', filePath });

    expect(response.isError).toBe(true);
    expect(spy.closes()).toBe(1);
  });

  it('远端 loopback 成功上传 → connector 端 openHandleCount 归零', async () => {
    const stack = await createRemoteLoopback();
    try {
      const { service } = await makeAttachmentUploader();
      const deviceWorkspace = await stack.deviceWorkspaceGateway.getWorkspacePath('conv-1');
      await mkdir(deviceWorkspace, { recursive: true });
      const filePath = path.join(deviceWorkspace, 'ok.md');
      await writeFile(filePath, '# 远端成功路径');
      const env = await stack.machine.createExecutionEnvironment(deviceWorkspace, 'conv-1');

      const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
      const { response } = await runTool(createUploadDeviceFileTool(ctx), { machine: 'node-a', filePath });

      expect(response.isError).toBeFalsy();
      expect(stack.fileExecutor.openHandleCount).toBe(0);
    } finally {
      await stack.cleanup();
    }
  });

  it('远端 loopback 上传被拒（尺寸闸，读到中途失败出口）→ openHandleCount 归零；不存在文件不开句柄', async () => {
    const stack = await createRemoteLoopback();
    try {
      const { service } = await makeAttachmentUploader({ maxDocumentBytes: 16 });
      const deviceWorkspace = await stack.deviceWorkspaceGateway.getWorkspacePath('conv-1');
      await mkdir(deviceWorkspace, { recursive: true });
      const filePath = path.join(deviceWorkspace, 'big.md');
      await writeFile(filePath, 'x'.repeat(4096));
      const env = await stack.machine.createExecutionEnvironment(deviceWorkspace, 'conv-1');

      const ctx = makeToolContext({ attachmentUpload: service, resolveExecutionEnv: async () => env });
      const { response } = await runTool(createUploadDeviceFileTool(ctx), { machine: 'node-a', filePath });

      expect(response.isError).toBe(true);
      expect(stack.fileExecutor.openHandleCount).toBe(0);

      // not_found 路径：从未打开句柄，计数保持 0
      const miss = await runTool(createUploadDeviceFileTool(ctx), { machine: 'node-a', filePath: path.join(deviceWorkspace, 'ghost.md') });
      expect(miss.response.isError).toBe(true);
      expect(stack.fileExecutor.openHandleCount).toBe(0);
    } finally {
      await stack.cleanup();
    }
  });
});

describe('upload_device_file 注册条件（旧装配零变化）', () => {
  it('双依赖齐备 → 注册', () => {
    const ctx = makeToolContext({
      attachmentUpload: { upload: async () => { throw new Error('not used'); } },
      resolveExecutionEnv: async () => ({}) as unknown as ExecutionEnv,
    });
    const tools = createTools(ctx);
    expect(tools.some(t => t.name === 'upload_device_file')).toBe(true);
  });

  it('缺 attachmentUpload → 不注册', () => {
    const ctx = makeToolContext({ resolveExecutionEnv: async () => ({}) as unknown as ExecutionEnv });
    const tools = createTools(ctx);
    expect(tools.some(t => t.name === 'upload_device_file')).toBe(false);
  });

  it('缺 resolveExecutionEnv → 不注册', () => {
    const ctx = makeToolContext({ attachmentUpload: { upload: async () => { throw new Error('not used'); } } });
    const tools = createTools(ctx);
    expect(tools.some(t => t.name === 'upload_device_file')).toBe(false);
  });
});
