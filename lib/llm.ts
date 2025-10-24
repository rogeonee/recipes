import crypto from 'node:crypto';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import {
  NoObjectGeneratedError,
  generateObject,
  TypeValidationError,
  zodSchema,
} from 'ai';
import type { LanguageModelUsage } from 'ai';
import * as cheerio from 'cheerio';
import { z } from 'zod';

import type { HeuristicExtraction } from './extractors.js';
import {
  clampInt,
  getDomain,
  normalizeSteps,
  parseIngredientLine,
} from './recipe-utils.js';
import { RecipeSchema, type Ingredient, type Recipe } from './recipe-schema.js';
import { inferUnitsFromIngredients } from './normalizers.js';
import { logLLMUsage } from './metrics.js';

const GOOGLE_MODEL_ID = 'gemini-2.0-flash';
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_TOKENS = 1_024;
const TEMPERATURE = 0.15;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CONTEXT_CHARS = 5_000;

type CacheEntry<T> = {
  expiresAt: number;
  data: T;
};

const cache = new Map<string, CacheEntry<unknown>>();

const LLMExtractionSchema = z.object({
  title: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
  servingsText: z.string().trim().min(1).nullable().optional(),
  servings: z.number().int().positive().nullable().optional(),
  prepMinutes: z.number().nonnegative().nullable().optional(),
  cookMinutes: z.number().nonnegative().nullable().optional(),
  totalMinutes: z.number().nonnegative().nullable().optional(),
  ingredients: z.array(z.string().trim().min(1)).default([]),
  steps: z.array(z.string().trim().min(1)).default([]),
  notes: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
  cuisines: z.array(z.string().trim().min(1)).default([]),
  methods: z.array(z.string().trim().min(1)).default([]),
});

const LLMEnrichmentSchema = z.object({
  title: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
  servingsText: z.string().trim().min(1).nullable().optional(),
  servings: z.number().int().positive().nullable().optional(),
  prepMinutes: z.number().nonnegative().nullable().optional(),
  cookMinutes: z.number().nonnegative().nullable().optional(),
  totalMinutes: z.number().nonnegative().nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  cuisines: z.array(z.string().trim().min(1)).optional(),
  methods: z.array(z.string().trim().min(1)).optional(),
});

let provider: ReturnType<typeof createGoogleGenerativeAI> | null = null;

const loadModel = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[llm] GEMINI_API_KEY missing; skipping LLM calls');
    return null;
  }
  if (!provider) {
    provider = createGoogleGenerativeAI({ apiKey });
  }
  return provider(GOOGLE_MODEL_ID);
};

const computeCacheKey = (prefix: string, url: string, html: string) => {
  const htmlHash = crypto.createHash('sha256').update(html).digest('hex');
  const combined = crypto
    .createHash('sha256')
    .update(url + htmlHash)
    .digest('hex');
  return `${prefix}:${combined}`;
};

const getFromCache = <T>(key: string): T | null => {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
};

const storeInCache = <T>(key: string, data: T): void => {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
};

const sanitizeLines = (lines: string[], limit: number) =>
  lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);

const reduceHtmlToText = (html: string, limit = MAX_CONTEXT_CHARS): string => {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    const text = $('body')
      .text()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    return text.slice(0, limit);
  } catch (err) {
    console.warn('[llm] failed to reduce html', err);
    return html.slice(0, limit);
  }
};

const buildContext = (params: {
  url: string;
  heuristics?: HeuristicExtraction | null;
  readableHtml?: string | null;
  html: string;
}) => {
  const { url, heuristics, readableHtml, html } = params;
  const segments: string[] = [`URL: ${url}`];
  if (heuristics?.title) {
    segments.push(`Heuristic title: ${heuristics.title}`);
  }
  if (heuristics?.ingredients?.length) {
    const lines = sanitizeLines(heuristics.ingredients, 40);
    segments.push(`Heuristic ingredients:\n- ${lines.join('\n- ')}`);
  }
  if (heuristics?.steps?.length) {
    const lines = sanitizeLines(heuristics.steps, 40);
    const numbered = lines.map((line, idx) => `${idx + 1}. ${line}`);
    segments.push(`Heuristic steps:\n${numbered.join('\n')}`);
  }
  const source = readableHtml || html;
  const text = reduceHtmlToText(source);
  segments.push(`Context excerpt:\n${text}`);
  return segments.join('\n\n');
};

const toRecipe = (
  data: z.infer<typeof LLMExtractionSchema>,
  url: string,
  heuristics?: HeuristicExtraction | null,
): Recipe => {
  const title = data.title ?? heuristics?.title ?? null;
  const description = data.description ?? null;
  const servings =
    typeof data.servings === 'number' && Number.isFinite(data.servings)
      ? data.servings
      : null;
  const yieldOriginal =
    data.servingsText?.trim() ||
    heuristics?.ingredients?.find((line) => /\bserves?\b/i.test(line)) ||
    null;

  const ingredients: Ingredient[] = (data.ingredients ?? [])
    .map((line) => parseIngredientLine(String(line)))
    .filter((i): i is Ingredient => Boolean(i));

  const steps = normalizeSteps((data.steps ?? []) as string[]);

  const tagsSet = new Set<string>();
  for (const collection of [data.tags, data.cuisines, data.methods]) {
    for (const tag of collection ?? []) {
      const clean = tag.trim().toLowerCase();
      if (clean) tagsSet.add(clean);
    }
  }

  const time = {
    prep: clampInt(data.prepMinutes),
    cook: clampInt(data.cookMinutes),
    total: clampInt(
      data.totalMinutes ??
        ((data.prepMinutes ?? 0) + (data.cookMinutes ?? 0) || null),
    ),
  };

  const fetchedAt = new Date().toISOString();

  return RecipeSchema.parse({
    title,
    description,
    image: heuristics?.image ?? null,
    author: null,
    yield: {
      servings: clampInt(servings),
      original: yieldOriginal,
    },
    time,
    ingredients,
    steps,
    tags: Array.from(tagsSet),
    dietFlags: {},
    units: inferUnitsFromIngredients(ingredients),
    source: {
      url,
      domain: getDomain(url),
      fetchedAt,
    },
    llmNotes: {
      extracted: 'llm',
      notes: (data.notes ?? []).filter(Boolean),
    },
  });
};

const mergeEnrichment = (
  base: Recipe,
  enrichment: z.infer<typeof LLMEnrichmentSchema>,
): Recipe => {
  const mergedTags = new Set<string>(base.tags);
  for (const block of [
    enrichment.tags,
    enrichment.cuisines,
    enrichment.methods,
  ]) {
    for (const tag of block ?? []) {
      const clean = tag.trim().toLowerCase();
      if (clean) mergedTags.add(clean);
    }
  }

  const servings =
    enrichment.servings != null
      ? clampInt(enrichment.servings)
      : base.yield.servings;

  const total =
    enrichment.totalMinutes != null
      ? clampInt(enrichment.totalMinutes)
      : base.time.total;

  const prep =
    enrichment.prepMinutes != null
      ? clampInt(enrichment.prepMinutes)
      : base.time.prep;

  const cook =
    enrichment.cookMinutes != null
      ? clampInt(enrichment.cookMinutes)
      : base.time.cook;

  const computedTotal =
    total != null
      ? total
      : (() => {
          const sum = (prep ?? 0) + (cook ?? 0);
          return sum > 0 ? sum : null;
        })();
  const finalTotal =
    computedTotal != null
      ? computedTotal
      : base.time.total != null
      ? base.time.total
      : null;

  const merged = {
    ...base,
    title: enrichment.title ?? base.title,
    description: enrichment.description ?? base.description,
    yield: {
      servings,
      original: enrichment.servingsText?.trim()
        ? enrichment.servingsText.trim()
        : base.yield.original,
    },
    time: {
      prep,
      cook,
      total: finalTotal,
    },
    tags: Array.from(mergedTags),
  };

  return RecipeSchema.parse(merged);
};

const callLLM = async <T>({
  kind,
  schema,
  context,
}: {
  kind: 'extract' | 'enrich';
  schema: z.ZodType<T>;
  context: string;
}): Promise<{ object: T; usage: LanguageModelUsage | null }> => {
  const model = loadModel();
  if (!model) throw new Error('LLM model unavailable');

  const systemBase =
    kind === 'extract'
      ? [
          'You are a disciplined recipe extraction engine.',
          'Extract only facts from the provided context.',
          'List ingredients with quantity before the item (e.g., "500 g beef chuck").',
          'Preserve every instruction; keep each step under two concise sentences.',
          'Identify cooking methods (braise, simmer, grill, sauté, etc.) and dish/category tags.',
          'Limit optional notes to the most useful facts (maximum three short items).',
          'If data is absent, respond with null instead of guessing.',
          'Do not invent numbers or convert units unless stated clearly.',
          'Output must strictly follow the provided JSON schema.',
        ].join(' ')
      : [
          'You refine existing recipe data with minimal, factual additions.',
          'Fill only missing fields when the context provides clear evidence.',
          'List ingredients with quantity before the item if you propose changes.',
          'Keep all steps present and concise; never drop or merge distinct actions.',
          'Expand tags with dish type, cuisine, and cooking methods evident from context.',
          'Limit optional notes to the most useful facts (maximum three short items).',
          'Never overwrite existing values with guesses or conflicting data.',
          'Return null for information that remains unknown.',
          'Output must strictly follow the provided JSON schema.',
        ].join(' ');

  let repairHint: string | null = null;
  let lastError: unknown = null;
  let contextForAttempt = context;

  const shrinkContext = (value: string) =>
    value.length > 3_500 ? value.slice(0, 3_500) : value;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timeoutMs = attempt === 0 ? REQUEST_TIMEOUT_MS : RETRY_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const promptParts = [contextForAttempt];
      if (repairHint) {
        promptParts.push(`Previous output failed validation: ${repairHint}`);
        promptParts.push('Return corrected JSON only.');
      }

      const messages = [
        { role: 'system' as const, content: systemBase },
        { role: 'user' as const, content: promptParts.join('\n\n') },
      ];

      const result = (await generateObject({
        model,
        schema: zodSchema(schema),
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        messages,
        abortSignal: controller.signal,
      } as any)) as {
        object: T;
        usage?: LanguageModelUsage | null;
      };
      clearTimeout(timer);
      return { object: result.object, usage: result.usage ?? null };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (err instanceof TypeValidationError) {
        repairHint = err.message;
        continue;
      }
      if (err instanceof NoObjectGeneratedError) {
        repairHint =
          'Previous response was truncated or not valid JSON. Return compact JSON only, fully close arrays/objects, and keep each step under 35 words.';
        contextForAttempt = shrinkContext(contextForAttempt);
        continue;
      }
      if (err instanceof Error && err.name === 'AbortError' && attempt < 2) {
        continue;
      }
    }
  }
  throw lastError ?? new Error('LLM call failed');
};

export const llmExtractFromHtml = async (params: {
  url: string;
  html: string;
  heuristics?: HeuristicExtraction | null;
  readableHtml?: string | null;
}): Promise<Recipe | null> => {
  const { url, html, heuristics, readableHtml } = params;
  const key = computeCacheKey('extract', url, html);
  const cached = getFromCache<Recipe>(key);
  if (cached) return cached;

  const context = buildContext({ url, heuristics, readableHtml, html });

  try {
    const { object, usage } = await callLLM({
      kind: 'extract',
      schema: LLMExtractionSchema,
      context,
    });
    logLLMUsage('extract', usage);
    const recipe = toRecipe(object, url, heuristics);
    storeInCache(key, recipe);
    return recipe;
  } catch (err) {
    if (err instanceof Error && err.message === 'LLM model unavailable') {
      console.warn('[llm] extract skipped (model unavailable)');
      return null;
    }
    console.warn('[llm] extract failed', err);
    return null;
  }
};

export const llmEnrichRecipe = async (params: {
  base: Recipe;
  html: string;
  heuristics?: HeuristicExtraction | null;
  readableHtml?: string | null;
}): Promise<Recipe | null> => {
  const { base, html, heuristics, readableHtml } = params;
  const url = base.source.url;
  const key = computeCacheKey('enrich', url, html);
  const cached = getFromCache<Recipe>(key);
  if (cached) return cached;

  const contextParts = [
    `URL: ${url}`,
    `Existing recipe JSON: ${JSON.stringify(base)}`,
    buildContext({ url, heuristics, readableHtml, html }),
  ];

  try {
    const { object, usage } = await callLLM({
      kind: 'enrich',
      schema: LLMEnrichmentSchema,
      context: contextParts.join('\n\n'),
    });
    logLLMUsage('enrich', usage);
    const merged = mergeEnrichment(base, object);
    storeInCache(key, merged);
    return merged;
  } catch (err) {
    if (err instanceof Error && err.message === 'LLM model unavailable') {
      console.warn('[llm] enrich skipped (model unavailable)');
      return null;
    }
    console.warn('[llm] enrich failed', err);
    return null;
  }
};
