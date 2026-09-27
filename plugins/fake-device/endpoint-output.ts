import type { JsonChannel, WriteCompletion } from "../../packages/runtime/src/transport.ts";

export type EndpointOutputKind = "ordinary" | "safety" | "query" | "event" | "emergency" | "setup";

type Usage = { count: number; bytes: number };
type ChannelBudget = {
  failed: boolean;
  usage: Record<EndpointOutputKind, Usage>;
  tickets: Set<EndpointOutputTicket>;
};

export type EndpointOutputTicket = {
  readonly channel: JsonChannel;
  readonly kind: EndpointOutputKind;
  bytes: number;
  submitted: boolean;
  settled: boolean;
};

const kinds: EndpointOutputKind[] = ["ordinary", "safety", "query", "event", "emergency", "setup"];

function frameBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : Buffer.byteLength(json);
  } catch {
    return null;
  }
}

/** Per-channel output isolation. At most one Host, two Supervisor and two candidate
 * channels exist, so the whole endpoint retains at most five bounded channel budgets.
 * A ticket lives until its actual local write completion or channel close, including
 * when write(false) accepted backpressure. Neither event nor response delivery is a peer ACK.
 */
export class EndpointOutput {
  readonly #maxBytes: number;
  readonly #counts: Record<EndpointOutputKind, number>;
  readonly #channels = new WeakMap<JsonChannel, ChannelBudget>();
  readonly #onFailure: (channel: JsonChannel, reason: string) => void;

  constructor(
    maxMessageBytes: number,
    ordinaryLimit: number,
    onFailure: (channel: JsonChannel, reason: string) => void,
  ) {
    this.#maxBytes = maxMessageBytes;
    this.#counts = {
      ordinary: ordinaryLimit,
      safety: 2,
      query: 2,
      event: 2,
      emergency: 1,
      setup: 4,
    };
    this.#onFailure = onFailure;
  }

  #state(channel: JsonChannel): ChannelBudget {
    let state = this.#channels.get(channel);
    if (state) return state;
    state = {
      failed: false,
      usage: Object.fromEntries(kinds.map((kind) => [kind, { count: 0, bytes: 0 }])) as Record<
        EndpointOutputKind,
        Usage
      >,
      tickets: new Set(),
    };
    this.#channels.set(channel, state);
    channel.once("closed", () => {
      state.failed = true;
      for (const ticket of [...state.tickets]) this.#settle(ticket);
    });
    return state;
  }

  failed(channel: JsonChannel): boolean {
    return channel.closed || this.#state(channel).failed;
  }

  markFailed(channel: JsonChannel): void {
    this.#state(channel).failed = true;
  }

  reserve(
    channel: JsonChannel,
    kind: EndpointOutputKind,
    value?: unknown,
  ): EndpointOutputTicket | null {
    const state = this.#state(channel);
    if (channel.closed || state.failed) return null;
    // A response reserves its full possible frame before dispatch. An already
    // constructed event reserves its exact complete envelope before any delay.
    const bytes = value === undefined ? this.#maxBytes : frameBytes(value);
    const usage = state.usage[kind];
    if (
      bytes === null ||
      bytes > this.#maxBytes ||
      usage.count >= this.#counts[kind] ||
      usage.bytes + bytes > this.#counts[kind] * this.#maxBytes
    )
      return null;
    const ticket: EndpointOutputTicket = {
      channel,
      kind,
      bytes,
      submitted: false,
      settled: false,
    };
    usage.count++;
    usage.bytes += bytes;
    state.tickets.add(ticket);
    return ticket;
  }

  send(ticket: EndpointOutputTicket, value: unknown, after?: (written: boolean) => void): void {
    if (ticket.settled || ticket.submitted) return;
    const state = this.#state(ticket.channel);
    if (state.failed || ticket.channel.closed) {
      ticket.channel.close();
      return;
    }
    const bytes = frameBytes(value);
    if (bytes === null || bytes > this.#maxBytes) {
      this.#fail(ticket.channel, "frame");
      return;
    }
    state.usage[ticket.kind].bytes += bytes - ticket.bytes;
    ticket.bytes = bytes;
    ticket.submitted = true;
    // send(false) can mean accepted Writable backpressure. Only the completion
    // callback or channel close settles the ticket; JsonChannel makes it once-only.
    ticket.channel.send(value, (completion: WriteCompletion) => {
      if (!this.#settle(ticket)) return;
      if (completion.status === "failed") this.#fail(ticket.channel, completion.reason);
      after?.(completion.status === "written");
    });
  }

  /** Only a never-submitted delayed event may be withdrawn. Submitted writes
   * remain charged until their completion or channel close.
   */
  cancel(ticket: EndpointOutputTicket): void {
    if (!ticket.submitted) this.#settle(ticket);
  }

  #settle(ticket: EndpointOutputTicket): boolean {
    if (ticket.settled) return false;
    ticket.settled = true;
    const state = this.#state(ticket.channel);
    state.tickets.delete(ticket);
    state.usage[ticket.kind].count--;
    state.usage[ticket.kind].bytes -= ticket.bytes;
    return true;
  }

  #fail(channel: JsonChannel, reason: string): void {
    const state = this.#state(channel);
    if (state.failed) return;
    state.failed = true; // Mark before the failure callback can fence and publish again.
    try {
      this.#onFailure(channel, reason);
    } finally {
      channel.close();
    }
  }

  usage(
    channel: JsonChannel,
    kind: EndpointOutputKind,
  ): Usage & { max_count: number; max_bytes: number } {
    return {
      ...this.#state(channel).usage[kind],
      max_count: this.#counts[kind],
      max_bytes: this.#counts[kind] * this.#maxBytes,
    };
  }
}
