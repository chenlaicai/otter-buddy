import { extractSvgBlocks, svgToPng } from './image-forward.mjs';
import { externalTokenBudgetMessage } from './otter-bridge.mjs';

/** 每轮注入海獭系统的图片上限（对齐海獭系统 dispatch-chain 的 vision 注入硬限制：每轮 ≤2 图）。 */
const MAX_IMAGES_PER_TURN = 2;

function base64ToBytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/**
 * 把海獭最终回复发回 CoLink。
 * - 频道：解析回复中的 SVG（≤2 个），渲染 PNG 后上传，用 messages.send 发「文字+图片」；
 * - 私聊：files.upload 需要 channelId（私聊没有），降级为纯文本回复。
 * 发送阶段不回抛异常——handler 失败会触发 SDK 重放，导致 bridge.reply 重复跑海獭 turn。
 */
async function forwardAnswer(ctx, kind, answer) {
  try {
    if (kind === 'channel') {
      const { svgs, text } = extractSvgBlocks(answer);
      if (svgs.length > 0) {
        const data = ctx.event.data;
        const fileIds = [];
        for (let i = 0; i < svgs.length; i++) {
          try {
            const bytes = await svgToPng(svgs[i]);
            const receipt = await ctx.colink.app.files.upload({
              bytes,
              idempotencyKey: `reply:${data.messageId}:img:${i}`,
              channelId: data.channelId,
              fileName: `image-${i + 1}.png`,
            });
            if (receipt?.fileId) fileIds.push(receipt.fileId);
          } catch (error) {
            // 单张渲染/上传失败逐张降级：跳过该图，不阻断其余图与文本。
            console.error(`[colink-app] image ${i} render/upload failed:`, error?.message ?? error);
          }
        }
        const body = text || (fileIds.length ? '[图片]' : '（图片生成失败，已省略）');
        await ctx.colink.app.messages.send({
          idempotencyKey: `reply:${data.messageId}`,
          text: body,
          ...(fileIds.length ? { fileIds } : {}),
          channelId: data.channelId,
          topicId: data.topicId,
        });
        return;
      }
    }
    await ctx.reply({ text: answer });
  } catch (error) {
    // 发送失败不回抛（见 forwardAnswer 注释）。
    console.error('[colink-app] reply delivery failed:', error?.message ?? error);
  }
}

/**
 * 按事件来源读一张图片的字节。
 * - 频道话题：readImage 返回 DiscussionImage（data 为 base64）
 * - 私聊：downloadAttachment 返回 BinaryResult（bytes + contentType）
 * 调用方 catch 全部异常做降级：读图失败只影响图片注入，不阻断文本消息。
 */
async function readEventImage(ctx, kind, fileId) {
  const data = ctx.event.data;
  if (kind === 'dm') {
    const result = await ctx.colink.user.directMessages.downloadAttachment({
      conversationId: data.conversationId,
      artifactId: fileId,
    });
    if (!result?.bytes?.length) return null;
    return { bytes: result.bytes, mimeType: result.contentType || 'image/png' };
  }
  const image = await ctx.colink.user.topics.readImage({
    topicId: data.topicId,
    artifactId: fileId,
  });
  if (!image?.data) return null;
  return { bytes: base64ToBytes(image.data), mimeType: image.mimeType || 'image/png' };
}

export function createMentionHandler({ bridge }) {
  return async ctx => {
    const data = ctx.event.data;
    const text = (data.text ?? '').trim();
    const fileIds = Array.isArray(data.fileIds) ? [...new Set(data.fileIds)].slice(0, MAX_IMAGES_PER_TURN) : [];

    let kind;
    let externalId;
    if (data.reason === 'dm_message' && data.conversationId) {
      // Why: 个人 DM 与频道统一由 CoLink 安装范围、事件验签和私密读取委托授权。
      kind = 'dm';
      externalId = data.conversationId;
    } else if (['mention', 'reply'].includes(data.reason) && data.channelId) {
      kind = 'channel';
      externalId = data.channelId;
    } else {
      throw new Error('ONLY_DM_AND_CHANNEL_TEXT_SUPPORTED');
    }

    // 下载本事件附带的图片（最多 2 张）；读图失败逐张降级，不阻断唤醒。
    const images = [];
    const failedImageIds = [];
    for (const fileId of fileIds) {
      try {
        const image = await readEventImage(ctx, kind, fileId);
        if (image) images.push({ fileId, fileName: image.mimeType === 'image/jpeg' ? 'colink-image.jpg' : 'colink-image.png', ...image });
        else failedImageIds.push(fileId);
      } catch {
        failedImageIds.push(fileId);
      }
    }
    // Why: 没有文本也没有可注入的图片时，这次唤醒没有可处理的内容，保持旧行为直接失败。
    if (!text && images.length === 0) throw new Error('EMPTY_MESSAGE_TEXT');

    let answer;
    try {
      answer = await bridge.reply({
        kind,
        deploymentId: ctx.event.deploymentId,
        installationId: ctx.context.installationId,
        conversationId: externalId,
        actorId: ctx.context.userId,
        text,
        images,
        failedImageIds,
        ctx,
        signal: ctx.signal,
      });
    } catch (error) {
      const budgetMessage = externalTokenBudgetMessage(error);
      if (!budgetMessage) throw error;
      // 额度是终态业务拒绝：正常回复后吞掉错误，SDK 不得重放整轮（重放只会再次超额）。
      await ctx.reply({ text: budgetMessage });
      return;
    }
    await forwardAnswer(ctx, kind, answer);
  };
}
