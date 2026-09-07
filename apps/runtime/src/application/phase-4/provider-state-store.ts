import type { MemoryProviderStateStore } from "@bellis/contracts/memory";
import type { PersistenceClient } from "@bellis/persistence";

export function providerStateStore(
  persistence: Pick<PersistenceClient, "phase4ReadProviderState" | "phase4WriteProviderState">,
  scopeKey: string,
  providerId: string,
): MemoryProviderStateStore {
  let revision: number | undefined;
  return {
    async load() {
      const snapshot = await persistence.phase4ReadProviderState({ scopeKey, providerId });
      revision = snapshot?.revision ?? 0;
      return snapshot?.state;
    },
    async save(state) {
      if (revision === undefined) throw new Error("provider_state_not_loaded");
      revision = await persistence.phase4WriteProviderState({
        scopeKey,
        providerId,
        expectedRevision: revision,
        state,
      });
    },
  };
}
