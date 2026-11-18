export function createMentionHandler({ bridge }) {
  return async ctx => {
    const data = ctx.event.data;
    const text = data.text?.trim();
    if (!text) throw new Error('EMPTY_MESSAGE_TEXT');

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

    const answer = await bridge.reply({
      kind,
      deploymentId: ctx.event.deploymentId,
      installationId: ctx.context.installationId,
      conversationId: externalId,
      actorId: ctx.context.userId,
      text,
      ctx,
      signal: ctx.signal,
    });
    await ctx.reply({ text: answer });
  };
}
