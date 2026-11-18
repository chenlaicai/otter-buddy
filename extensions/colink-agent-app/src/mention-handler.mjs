/** 每轮注入海獭系统的图片上限（对齐海獭系统 dispatch-chain 的 vision 注入硬限制：每轮 ≤2 图）。 */
const MAX_IMAGES_PER_TURN = 2;

function base64ToBytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
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

    const answer = await bridge.reply({
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
    await ctx.reply({ text: answer });
  };
}
