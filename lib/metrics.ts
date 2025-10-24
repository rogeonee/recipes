export type StrategyHit =
  | 'json-ld'
  | 'microdata'
  | 'heuristics'
  | 'readability-heuristics'
  | 'llm-fallback'
  | 'llm-enrich';

type UsageKind = 'extract' | 'enrich';

type TokenUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
};

const strategyCounters: Record<StrategyHit, number> = {
  'json-ld': 0,
  microdata: 0,
  heuristics: 0,
  'readability-heuristics': 0,
  'llm-fallback': 0,
  'llm-enrich': 0,
};

export const recordStrategyHit = (strategy: StrategyHit): void => {
  strategyCounters[strategy] += 1;
  console.info('[strategy]', strategy, 'count', strategyCounters[strategy]);
};

export const logLLMUsage = (
  kind: UsageKind,
  usage: TokenUsage | null | undefined,
): void => {
  if (!usage) return;
  const prompt = usage.inputTokens ?? usage.totalTokens ?? null;
  const completion = usage.outputTokens ?? usage.totalTokens ?? null;
  const total = usage.totalTokens ?? null;
  const reasoning = usage.reasoningTokens ?? null;
  console.info('[llm-usage]', kind, {
    prompt,
    completion,
    total,
    reasoning,
  });
};
