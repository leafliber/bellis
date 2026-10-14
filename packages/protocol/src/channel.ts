import Type, { type Static } from 'typebox';

/**
 * 本机通道的握手消息（D-12、R-05）。
 * 双方互发随机数，各自用会话密钥对握手记录做 HMAC-SHA256 证明持有密钥；
 * 服务端先证明，客户端核验通过后才回送自己的证明，认证完成前不传任何业务数据。
 */

const closed = { additionalProperties: false } as const;

/** 握手协议版本。 */
export const ChannelVersion = Type.Literal(1);

/** 32 字节随机数或 HMAC-SHA256 值的 base64url（无填充）编码。 */
export const ChannelBytes32 = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' });

/** 客户端声明的角色，例如 `watchdog`、`sidecar.tts`；参与 HMAC，被认证。 */
export const ChannelRole = Type.String({ pattern: '^[a-z][a-z0-9_.:-]{0,63}$' });

export const ChannelHello = Type.Object(
  { v: ChannelVersion, type: Type.Literal('hello'), role: ChannelRole, nonce: ChannelBytes32 },
  closed,
);
export type ChannelHello = Static<typeof ChannelHello>;

export const ChannelChallenge = Type.Object(
  {
    v: ChannelVersion,
    type: Type.Literal('challenge'),
    nonce: ChannelBytes32,
    proof: ChannelBytes32,
  },
  closed,
);
export type ChannelChallenge = Static<typeof ChannelChallenge>;

export const ChannelProof = Type.Object(
  { v: ChannelVersion, type: Type.Literal('proof'), proof: ChannelBytes32 },
  closed,
);
export type ChannelProof = Static<typeof ChannelProof>;

export const ChannelAccept = Type.Object(
  { v: ChannelVersion, type: Type.Literal('accept') },
  closed,
);
export type ChannelAccept = Static<typeof ChannelAccept>;
