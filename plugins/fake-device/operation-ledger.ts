import { type CommandContext, payloadDigest } from "../../packages/contract-sdk/src/index.ts";
import { reject } from "../../packages/runtime/src/errors.ts";

export type EndpointLedgerKind = "ordinary" | "safety" | "query";

export type EndpointOperationIdentity = {
  peer_role: "host" | "supervisor";
  peer_instance_id: string;
  session_id: string;
  endpoint_instance_id: string;
  operation_id: string;
};

type RetainedOperation = {
  category: EndpointLedgerKind;
  identity: EndpointOperationIdentity;
  business_digest: string;
  bound_connection_id: string | null;
  result: unknown;
};

export type EndpointOperationReservation = {
  key: string;
  record: Omit<RetainedOperation, "result">;
  maximum_bytes: number;
};

const categories: EndpointLedgerKind[] = ["ordinary", "safety", "query"];
const MAX_RECORDS_PER_CATEGORY = 128;

export function endpointBusinessDigest(
  method: string,
  input: Record<string, unknown>,
  context: CommandContext,
): string {
  const { proof: _proof, mapping: _mapping, ...businessInput } = input;
  return payloadDigest({
    method,
    input: businessInput,
    context: { ...context, payload_digest: null },
  });
}

function encodedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) reject("QUEUE_LIMIT_EXCEEDED");
  return Buffer.byteLength(json);
}

/** One endpoint instance owns every operation, regardless of which authenticated channel carried it. */
export class EndpointOperationLedger {
  readonly #maximumResultBytes: number;
  readonly #maximumCategoryBytes: number;
  readonly #records = new Map<string, RetainedOperation>();
  readonly #used = new Map<EndpointLedgerKind, { count: number; bytes: number }>(
    categories.map((category) => [category, { count: 0, bytes: 0 }]),
  );

  constructor(maxMessageBytes: number) {
    this.#maximumResultBytes = maxMessageBytes;
    this.#maximumCategoryBytes = 4 * maxMessageBytes;
  }

  static key(identity: EndpointOperationIdentity): string {
    return JSON.stringify([
      identity.peer_role,
      identity.peer_instance_id,
      identity.session_id,
      identity.endpoint_instance_id,
      identity.operation_id,
    ]);
  }

  lookup(
    identity: EndpointOperationIdentity,
    businessDigest: string,
    connectionId: string,
  ): { found: boolean; result?: unknown } {
    const previous = this.#records.get(EndpointOperationLedger.key(identity));
    if (!previous) return { found: false };
    if (previous.business_digest !== businessDigest) reject("OPERATION_PAYLOAD_CONFLICT");
    if (previous.bound_connection_id !== null && previous.bound_connection_id !== connectionId)
      reject("OPERATION_PAYLOAD_CONFLICT");
    return { found: true, result: structuredClone(previous.result) };
  }

  reserve(
    category: EndpointLedgerKind,
    identity: EndpointOperationIdentity,
    businessDigest: string,
    boundConnectionId: string | null,
  ): EndpointOperationReservation | null {
    const key = EndpointOperationLedger.key(identity);
    if (this.#records.has(key)) throw new Error("ENDPOINT_LEDGER_RESERVE_EXISTING_OPERATION");
    const record = {
      category,
      identity: structuredClone(identity),
      business_digest: businessDigest,
      bound_connection_id: boundConnectionId,
    };
    // Every valid result must fit one M-byte wire message. Reserve that full upper bound
    // before a mutable command runs, then charge the exact retained JSON bytes at commit.
    const maximumBytes =
      encodedBytes({ ...record, result: null }) - encodedBytes(null) + this.#maximumResultBytes;
    const usage = this.#used.get(category);
    if (!usage) throw new Error("ENDPOINT_LEDGER_UNKNOWN_CATEGORY");
    if (
      usage.count >= MAX_RECORDS_PER_CATEGORY ||
      usage.bytes + maximumBytes > this.#maximumCategoryBytes
    )
      return null;
    return { key, record, maximum_bytes: maximumBytes };
  }

  commit(reservation: EndpointOperationReservation, result: unknown): void {
    const retained: RetainedOperation = {
      ...reservation.record,
      result: structuredClone(result),
    };
    const bytes = encodedBytes(retained);
    const usage = this.#used.get(retained.category);
    if (!usage) throw new Error("ENDPOINT_LEDGER_UNKNOWN_CATEGORY");
    if (
      this.#records.has(reservation.key) ||
      bytes > reservation.maximum_bytes ||
      usage.count >= MAX_RECORDS_PER_CATEGORY ||
      usage.bytes + bytes > this.#maximumCategoryBytes
    )
      reject("QUEUE_LIMIT_EXCEEDED");
    this.#records.set(reservation.key, retained);
    usage.count++;
    usage.bytes += bytes;
  }

  usage(category: EndpointLedgerKind): { count: number; bytes: number; maximum_bytes: number } {
    const value = this.#used.get(category);
    if (!value) throw new Error("ENDPOINT_LEDGER_UNKNOWN_CATEGORY");
    return { ...value, maximum_bytes: this.#maximumCategoryBytes };
  }
}
