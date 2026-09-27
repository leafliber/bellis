import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { clockMapping, MonotonicClock, mappedDeadline } from "../packages/runtime/src/clock.ts";
import {
  announce,
  announcementEvent,
  generateIdentity,
  verifyAnnouncement,
} from "../packages/runtime/src/identity.ts";
import { limits } from "./p0-identity.helpers.ts";

class ControlledClock extends MonotonicClock {
  time = 1000;
  override now(): number {
    return this.time;
  }
}

test("p0.clock: signed cold-start samples admit only the configured error and never extend a source deadline", () => {
  const endpoint = generateIdentity("endpoint");
  const supervisor = generateIdentity("supervisor");
  const source = new ControlledClock();
  const target = new ControlledClock();
  target.time = 1250;
  const actualOffset = target.now() - source.now();
  const sent = source.now();

  source.time += 600;
  target.time += 600;
  const announcement = verifyAnnouncement(
    announcementEvent(
      announce(endpoint, randomUUID(), target, limits.clock_mapping_ttl_ms, supervisor.public, 0),
    ),
    endpoint.public,
    supervisor.public,
  );
  source.time += 1000;
  target.time += 1000;
  const received = source.now();
  const mapping = clockMapping(announcement, source, "host-instance", sent, received, limits);
  assert.equal(mapping.max_error_ms, 1602);
  assert.ok(mapping.max_error_ms > 1000 && mapping.max_error_ms < limits.max_clock_error_ms);
  assert.ok(mapping.offset_lower_ms <= actualOffset);
  assert.ok(actualOffset <= mapping.offset_upper_ms);

  const originalSourceExpiry = source.now() + limits.peer_health_timeout_ms;
  const deadline = mappedDeadline(mapping, source.now(), limits.peer_health_timeout_ms);
  assert.equal(deadline.clock_domain, target.domain);
  assert.ok(deadline.expires_at_ms > target.now());
  assert.ok(deadline.expires_at_ms <= originalSourceExpiry + actualOffset);
  assert.ok(deadline.expires_at_ms <= mapping.target_valid_until_ms);

  source.time += 300;
  target.time += 300;
  const retry = mappedDeadline(mapping, source.now(), originalSourceExpiry - source.now());
  assert.equal(retry.expires_at_ms, deadline.expires_at_ms);
  assert.throws(
    () =>
      clockMapping(announcement, source, "host-instance", sent, received, {
        ...limits,
        max_clock_error_ms: 1000,
      }),
    /CLOCK_MAPPING_INVALID/,
  );

  const lateSource = new ControlledClock();
  const lateTarget = new ControlledClock();
  lateTarget.time = 1250;
  const lateSent = lateSource.now();
  lateSource.time += 300;
  lateTarget.time += 300;
  const lateAnnouncement = verifyAnnouncement(
    announcementEvent(
      announce(
        endpoint,
        randomUUID(),
        lateTarget,
        limits.clock_mapping_ttl_ms,
        supervisor.public,
        0,
      ),
    ),
    endpoint.public,
    supervisor.public,
  );
  lateSource.time += 1900;
  lateTarget.time += 1900;
  const lateReceived = lateSource.now();
  assert.equal(
    lateReceived - lateSent + lateAnnouncement.sent_at_ms - lateAnnouncement.received_at_ms + 2,
    2202,
  );
  assert.throws(
    () =>
      clockMapping(lateAnnouncement, lateSource, "host-instance", lateSent, lateReceived, limits),
    /CLOCK_MAPPING_INVALID/,
  );
});
