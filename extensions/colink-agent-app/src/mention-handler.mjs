export function createMentionHandler({ bridge, allowedUserIds, deploymentId }) {
  return async turn => {
    const actorId = turn.context.userId;
    if (!allowedUserIds.has(actorId)) throw new Error('COLINK_USER_NOT_ALLOWED');
    const text = turn.input.text?.trim();
    if (!text) throw new Error('EMPTY_MESSAGE_TEXT');

    let kind;
    let externalId;
    if (turn.input.reason === 'dm_message' && turn.input.conversationId) {
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
