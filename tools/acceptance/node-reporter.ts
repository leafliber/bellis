// Raw node:test events, separate from child stdout (which remains a test:stdout event).
import type { TestEvent } from "node:test/reporters";
export default async function* reporter(events: AsyncIterable<TestEvent>) {
  let sequence = 0;
  for await (const event of events) {
    yield `${JSON.stringify({ sequence: sequence++, event }, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value))}\n`;
  }
}
