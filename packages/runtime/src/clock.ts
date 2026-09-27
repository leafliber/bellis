import { randomUUID } from "node:crypto";
import {
  assertValid,
  type Deadline,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0SafetyLimits,
  payloadDigest,
} from "../../contract-sdk/src/index.ts";
import { reject } from "./errors.ts";

export class MonotonicClock {
  readonly domain: string;
  readonly origin: bigint;
  constructor(domain = `clock-${randomUUID()}`, origin = process.hrtime.bigint()) {
    this.domain = domain;
    this.origin = origin;
  }
  now(): number {
    return Number((process.hrtime.bigint() - this.origin) / 1_000_000n);
  }
  point() {
    return { clock_domain: this.domain, monotonic_ms: this.now() };
  }
}

export function clockMapping(
  announcement: P0ConnectionAnnouncement,
  source: MonotonicClock,
  sourceInstance: string,
  sent: number,
  received: number,
  limits: P0SafetyLimits,
): P0ClockMapping {
  const lower = announcement.sent_at_ms - received - 1;
  const upper = announcement.received_at_ms - sent + 1;
  const sourceUntil = received + limits.clock_mapping_ttl_ms;
  const mapping: P0ClockMapping = {
    mapping_id: randomUUID(),
    connection_id: announcement.connection_id,
    source_instance_id: sourceInstance,
    target_instance_id: announcement.service_instance_id,
    source_clock_domain: source.domain,
    target_clock_domain: announcement.clock_domain,
    source_sent_at_ms: sent,
    source_received_at_ms: received,
    target_received_at_ms: announcement.received_at_ms,
    target_sent_at_ms: announcement.sent_at_ms,
    offset_lower_ms: lower,
    offset_upper_ms: upper,
    max_error_ms: upper - lower,
    source_valid_until_ms: sourceUntil,
    target_valid_until_ms: Math.min(sourceUntil + lower, announcement.expires_at_ms),
    announcement_digest: payloadDigest(announcement),
  };
  validateMapping(mapping, announcement, sourceInstance, limits);
  if (source.now() >= mapping.source_valid_until_ms) reject("CLOCK_MAPPING_INVALID");
  return mapping;
}

export function validateMapping(
  mapping: P0ClockMapping,
  a: P0ConnectionAnnouncement,
  sourceInstance: string,
  limits: P0SafetyLimits,
  targetNow?: number,
): void {
  if (!Number.isSafeInteger(mapping.offset_upper_ms - mapping.offset_lower_ms))
    reject("CLOCK_MAPPING_INVALID");
  assertValid("P0ClockMapping", mapping);
  const lower = a.sent_at_ms - mapping.source_received_at_ms - 1;
  const upper = a.received_at_ms - mapping.source_sent_at_ms + 1;
  if (
    mapping.connection_id !== a.connection_id ||
    mapping.source_instance_id !== sourceInstance ||
    mapping.target_instance_id !== a.service_instance_id ||
    mapping.target_clock_domain !== a.clock_domain ||
    mapping.source_clock_domain === mapping.target_clock_domain ||
    mapping.announcement_digest !== payloadDigest(a) ||
    mapping.target_received_at_ms !== a.received_at_ms ||
    mapping.target_sent_at_ms !== a.sent_at_ms ||
    mapping.source_sent_at_ms > mapping.source_received_at_ms ||
    a.received_at_ms > a.sent_at_ms ||
    mapping.offset_lower_ms !== lower ||
    mapping.offset_upper_ms !== upper ||
    lower > upper ||
    mapping.max_error_ms !== upper - lower ||
    mapping.max_error_ms > limits.max_clock_error_ms ||
    mapping.source_valid_until_ms <= mapping.source_received_at_ms ||
    mapping.source_valid_until_ms > mapping.source_received_at_ms + limits.clock_mapping_ttl_ms ||
    mapping.target_valid_until_ms !==
      Math.min(mapping.source_valid_until_ms + lower, a.expires_at_ms) ||
    mapping.target_valid_until_ms <= a.sent_at_ms ||
    (targetNow !== undefined && targetNow >= mapping.target_valid_until_ms)
  )
    reject("CLOCK_MAPPING_INVALID");
}

export function mappedDeadline(
  mapping: P0ClockMapping,
  sourceNow: number,
  timeoutMs: number,
): Deadline {
  if (
    sourceNow >= mapping.source_valid_until_ms ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(timeoutMs)
  )
    reject("CLOCK_MAPPING_INVALID");
  const issued = Math.max(0, sourceNow + mapping.offset_lower_ms);
  const expires = Math.min(
    sourceNow + timeoutMs + mapping.offset_lower_ms,
    mapping.target_valid_until_ms,
  );
  if (!Number.isSafeInteger(expires) || expires <= issued) reject("CLOCK_MAPPING_INVALID");
  return {
    clock_domain: mapping.target_clock_domain,
    issued_at_ms: issued,
    expires_at_ms: expires,
  };
}

export function checkDeadline(deadline: Deadline, clock: MonotonicClock): void {
  if (deadline.clock_domain !== clock.domain) reject("COMMAND_CLOCK_MISMATCH");
  const now = clock.now();
  if (deadline.issued_at_ms > now || deadline.expires_at_ms <= deadline.issued_at_ms)
    reject("TIMEOUT_INVALID");
  if (deadline.expires_at_ms <= now) reject("COMMAND_DEADLINE_MISSED");
}
