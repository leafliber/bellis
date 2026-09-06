import {
  ContextContributionSchema,
  MemoryProviderCapabilitiesSchema,
  type MemoryObserveEvent,
  type MemoryProvider,
  type MemoryQuery,
  type MemoryUsageReport,
} from "@bellis/contracts/memory";

export interface MemoryProviderConformanceCase {
  readonly provider: MemoryProvider;
  readonly query: MemoryQuery;
  readonly tokenBudget: number;
  readonly deadlineMs: number;
  readonly observeEvent?: MemoryObserveEvent;
  readonly usageReport?: MemoryUsageReport;
}

/**
 * Shared black-box checks for in-tree and external MemoryProvider plugins.
 * The harness deliberately imports only the public memory contract subpath.
 */
export async function assertMemoryProviderConformance(
  fixture: MemoryProviderConformanceCase,
): Promise<void> {
  const signal = new AbortController().signal;
  const capabilities = await fixture.provider.capabilities(signal);
  const parsedCapabilities = MemoryProviderCapabilitiesSchema.safeParse(capabilities);
  if (!parsedCapabilities.success) {
    throw new Error(`invalid provider capabilities: ${parsedCapabilities.error.message}`);
  }

  const contribution = await fixture.provider.provideContext(
    fixture.query,
    { tokenBudget: fixture.tokenBudget, deadlineMs: fixture.deadlineMs },
    signal,
  );
  const parsedContribution = ContextContributionSchema.safeParse(contribution);
  if (!parsedContribution.success) {
    throw new Error(`invalid context contribution: ${parsedContribution.error.message}`);
  }
  if (contribution.providerId !== fixture.provider.id) {
    throw new Error("contribution.providerId must equal provider.id");
  }
  if (contribution.requestId !== fixture.query.queryId) {
    throw new Error("contribution.requestId must equal query.queryId");
  }
  if (
    contribution.blocks.reduce((total, block) => total + block.tokenEstimate, 0) >
    fixture.tokenBudget
  ) {
    throw new Error("provider contribution exceeds the requested token budget");
  }
  if (fixture.observeEvent !== undefined && capabilities.observe) {
    if (fixture.provider.observe === undefined) throw new Error("observe capability has no method");
    await fixture.provider.observe([fixture.observeEvent], signal);
  }
  if (fixture.usageReport !== undefined && capabilities.usageReport) {
    if (fixture.provider.reportUsage === undefined) {
      throw new Error("usageReport capability has no method");
    }
    await fixture.provider.reportUsage(fixture.usageReport, signal);
  }
}
