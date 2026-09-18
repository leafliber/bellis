import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  assertValid,
  type CommandContext,
  canonicalJson,
  type P0ConnectionAnnouncement,
  type P0OperatorCredential,
  type P0OperatorProof,
  type P0PeerIdentity,
  type P0PeerProof,
  payloadDigest,
  type RpcEvent,
  type RpcRequest,
  schemaDigest,
} from "../../contract-sdk/src/index.ts";
import type { MonotonicClock } from "./clock.ts";
import { reject } from "./errors.ts";

export type Identity = { public: P0PeerIdentity; privateKey: KeyObject };

export function generateIdentity(role: P0PeerIdentity["role"]): Identity {
  const { privateKey } = generateKeyPairSync("ed25519");
  return identityFromKey(role, randomUUID(), randomUUID(), privateKey);
}

export function identityFromKey(
  role: P0PeerIdentity["role"],
  instance: string,
  keyId: string,
  key: string | KeyObject,
): Identity {
  const privateKey = typeof key === "string" ? createPrivateKey(key) : key;
  if (privateKey.asymmetricKeyType !== "ed25519") reject("AUTHENTICATION_REQUIRED");
  return {
    privateKey,
    public: {
      role,
      instance_id: instance,
      identity_key_id: keyId,
      public_key_spki: createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  };
}

export function exportPrivate(identity: Identity): string {
  return identity.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function signedBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}\0${canonicalJson(value)}`, "utf8");
}

export function announce(
  identity: Identity,
  session: string,
  clock: MonotonicClock,
  ttlMs: number,
  authority: P0PeerIdentity,
  authorityEpoch: number,
): P0ConnectionAnnouncement {
  assertValid("P0PeerIdentity", authority);
  if (
    authority.role !== "supervisor" ||
    !Number.isSafeInteger(authorityEpoch) ||
    authorityEpoch < 0 ||
    (identity.public.role === "supervisor" &&
      payloadDigest(identity.public) !== payloadDigest(authority))
  )
    reject("AUTHENTICATION_REQUIRED");
  const received = clock.now();
  const body: Omit<P0ConnectionAnnouncement, "signature"> = {
    connection_id: randomUUID(),
    service_role: identity.public.role,
    service_instance_id: identity.public.instance_id,
    session_id: session,
    protocol_version: "0.8.0",
    schema_digest: schemaDigest,
    clock_domain: clock.domain,
    received_at_ms: received,
    sent_at_ms: clock.now(),
    expires_at_ms: received + ttlMs,
    challenge_id: randomUUID(),
    identity_key_id: identity.public.identity_key_id,
    authority_id: authority.role,
    authority_instance_id: authority.instance_id,
    authority_epoch: authorityEpoch,
  };
  return {
    ...body,
    signature: sign(null, signedBytes("Bellis-P0-connection", body), identity.privateKey).toString(
      "base64",
    ),
  };
}

export function announcementEvent(a: P0ConnectionAnnouncement): RpcEvent {
  const value: RpcEvent = {
    jsonrpc: "2.0",
    method: "event.publish",
    params: {
      schema_version: "0.8.0",
      event_name: "connection.announced",
      event_id: randomUUID(),
      authority_id: a.service_role,
      source_instance: a.service_instance_id,
      authority_epoch: a.authority_epoch,
      source_seq: 0,
      session_id: a.session_id,
      scope_ref: { kind: "Connection", id: a.connection_id },
      correlation: { key: "connection_id", value: a.connection_id },
      occurred_at: { clock_domain: a.clock_domain, monotonic_ms: a.sent_at_ms },
      trace_id: randomUUID(),
      payload: a,
    },
  };
  assertValid("RpcEvent", value);
  return value;
}

export function verifyAnnouncement(
  event: unknown,
  expected: P0PeerIdentity,
  authority: P0PeerIdentity = expected,
): P0ConnectionAnnouncement {
  assertValid("P0PeerIdentity", authority);
  assertValid("RpcEvent", event);
  const envelope = event.params;
  if (envelope.event_name !== "connection.announced") reject("AUTHENTICATION_REQUIRED");
  const a = envelope.payload;
  assertValid("P0ConnectionAnnouncement", a);
  const { signature, ...body } = a;
  if (
    a.service_role !== expected.role ||
    a.service_instance_id !== expected.instance_id ||
    a.identity_key_id !== expected.identity_key_id ||
    a.protocol_version !== "0.8.0" ||
    a.schema_digest !== schemaDigest ||
    authority.role !== "supervisor" ||
    (expected.role === "supervisor" && payloadDigest(expected) !== payloadDigest(authority)) ||
    a.authority_id !== authority.role ||
    a.authority_instance_id !== authority.instance_id ||
    envelope.authority_id !== expected.role ||
    envelope.source_instance !== expected.instance_id ||
    envelope.authority_epoch !== a.authority_epoch ||
    envelope.session_id !== a.session_id ||
    envelope.scope_ref.kind !== "Connection" ||
    envelope.scope_ref.id !== a.connection_id ||
    envelope.occurred_at?.clock_domain !== a.clock_domain ||
    envelope.occurred_at.monotonic_ms !== a.sent_at_ms ||
    a.received_at_ms > a.sent_at_ms ||
    a.expires_at_ms <= a.sent_at_ms ||
    !verify(
      null,
      signedBytes("Bellis-P0-connection", body),
      createPublicKey(expected.public_key_spki),
      Buffer.from(signature, "base64"),
    )
  ) {
    reject("AUTHENTICATION_REQUIRED");
  }
  return a;
}

function withoutProof(input: object): Record<string, unknown> {
  const clean = { ...input } as Record<string, unknown>;
  delete clean.proof;
  return clean;
}

export function authenticationDigest(
  method: string,
  context: CommandContext,
  input: object,
): string {
  const { payload_digest: _digest, ...fixedContext } = context;
  return payloadDigest({ method, context: fixedContext, input: withoutProof(input) });
}

export function operatorRequest(
  method: string,
  input: object,
  context: CommandContext,
  a: P0ConnectionAnnouncement,
  credential: P0OperatorCredential,
): RpcRequest {
  const unsigned: Omit<P0OperatorProof, "proof_hmac"> = {
    credential_id: credential.credential_id,
    announcement_digest: payloadDigest(a),
    challenge_id: a.challenge_id,
    connection_id: a.connection_id,
    service_instance_id: a.service_instance_id,
    client_instance_id: context.caller_instance_id,
    client_nonce: randomUUID(),
    request_digest: authenticationDigest(method, context, input),
  };
  const proof = {
    ...unsigned,
    proof_hmac: createHmac("sha256", Buffer.from(credential.authentication_key_sha256, "hex"))
      .update(canonicalJson(unsigned))
      .digest("hex"),
  };
  return completeRequest(method, { ...input, proof }, context);
}

export function peerRequest(
  input: object,
  context: CommandContext,
  a: P0ConnectionAnnouncement,
  identity: Identity,
): RpcRequest {
  const unsigned: Omit<P0PeerProof, "signature"> = {
    announcement_digest: payloadDigest(a),
    challenge_id: a.challenge_id,
    connection_id: a.connection_id,
    service_instance_id: a.service_instance_id,
    client_instance_id: identity.public.instance_id,
    client_role: identity.public.role,
    client_nonce: randomUUID(),
    request_digest: authenticationDigest("connection.authenticate", context, input),
  };
  const proof = {
    ...unsigned,
    signature: sign(null, signedBytes("Bellis-P0-peer", unsigned), identity.privateKey).toString(
      "base64",
    ),
  };
  return completeRequest("connection.authenticate", { ...input, proof }, context);
}

export function completeRequest(
  method: string,
  input: object,
  context: CommandContext,
): RpcRequest {
  const request = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params: { context: { ...context, payload_digest: payloadDigest({ method, input }) }, input },
  };
  assertValid("RpcRequest", request);
  return request;
}

export class ConnectionAuthentication {
  #consumed = false;
  readonly announcement: P0ConnectionAnnouncement;
  constructor(announcement: P0ConnectionAnnouncement) {
    this.announcement = announcement;
  }

  #binding(proof: P0OperatorProof | P0PeerProof, request: RpcRequest, now: number): void {
    const a = this.announcement;
    if (
      this.#consumed ||
      now >= a.expires_at_ms ||
      proof.announcement_digest !== payloadDigest(a) ||
      proof.challenge_id !== a.challenge_id ||
      proof.connection_id !== a.connection_id ||
      proof.service_instance_id !== a.service_instance_id ||
      proof.client_instance_id !== request.params.context.caller_instance_id ||
      proof.request_digest !==
        authenticationDigest(request.method, request.params.context, request.params.input)
    )
      reject("AUTHENTICATION_REQUIRED");
  }

  operator(
    request: RpcRequest,
    credential: P0OperatorCredential,
    now: number,
  ): P0OperatorCredential {
    const input = request.params.input;
    if (!("proof" in input)) reject("AUTHENTICATION_REQUIRED");
    assertValid("P0OperatorProof", input.proof);
    this.#binding(input.proof, request, now);
    const { proof_hmac, ...body } = input.proof;
    const expected = createHmac("sha256", Buffer.from(credential.authentication_key_sha256, "hex"))
      .update(canonicalJson(body))
      .digest();
    const received = Buffer.from(proof_hmac, "hex");
    if (
      input.proof.credential_id !== credential.credential_id ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      reject("AUTHENTICATION_REQUIRED");
    this.#consumed = true;
    return credential;
  }

  peer(request: RpcRequest, allowed: readonly P0PeerIdentity[], now: number): P0PeerIdentity {
    if (request.method !== "connection.authenticate") reject("AUTHENTICATION_REQUIRED");
    const proof = request.params.input.proof;
    this.#binding(proof, request, now);
    const pinned = allowed.find(
      (p) => p.role === proof.client_role && p.instance_id === proof.client_instance_id,
    );
    const { signature, ...body } = proof;
    if (
      !pinned ||
      !verify(
        null,
        signedBytes("Bellis-P0-peer", body),
        createPublicKey(pinned.public_key_spki),
        Buffer.from(signature, "base64"),
      )
    )
      reject("AUTHENTICATION_REQUIRED");
    this.#consumed = true;
    return pinned;
  }
}
