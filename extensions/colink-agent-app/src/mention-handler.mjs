export function createMentionHandler({ bridge, deploymentId }) {
  return async turn => {
    const actorId = turn.context.userId;
    const text = turn.input.text?.trim();
    if (!text) throw new Error('EMPTY_MESSAGE_TEXT');

    let kind;
    let externalId;
    if (turn.input.reason === 'dm_message' && turn.input.conversationId) {
      // Why: 个人 DM 与频道统一由 CoLink 安装范围、事件验签和私密读取委托授权。
      kind = 'dm';
      externalId = turn.input.conversationId;
    } else if (['mention', 'reply'].includes(turn.input.reason) && turn.input.channelId) {
      kind = 'channel';
      externalId = turn.input.channelId;
    } else {
      throw new Error('ONLY_DM_AND_CHANNEL_TEXT_SUPPORTED');
    }

    const answer = await bridge.reply({
      kind,
      deploymentId,
      installationId: turn.context.installationId,
      conversationId: externalId,
      actorId,
      text,
      turn,
      signal: turn.signal,
    });
    await turn.reply({ text: answer });
  };
}
