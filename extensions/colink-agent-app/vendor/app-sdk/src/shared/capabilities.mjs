// Fixed business identities. The repository contract test checks these against
// the platform permission registry; consumers need no platform source dependency.
export const CAPABILITIES = Object.freeze({
    privateMessages: Object.freeze({ identity: 'user', scope: 'messages:read-private', tool: 'colink_read_private_topic' }),
    publicMessages: Object.freeze({ identity: 'app', scope: 'messages:read-public', tool: 'colink_read_public_topic' }),
    reply: Object.freeze({ identity: 'app', scope: 'messages:write' }),
});
