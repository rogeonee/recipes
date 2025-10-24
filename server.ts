import type { Request, Response } from 'express';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import 'dotenv/config';

import {
  extractHeuristics,
  extractJSONLDRecipe,
  extractMicrodataRecipe,
} from './lib/extractors.js';
import {
  normalizeFromHeuristics,
  normalizeFromJSONLD,
} from './lib/normalizers.js';
import { extractReadableContent } from './lib/readability.js';
import { llmEnrichRecipe, llmExtractFromHtml } from './lib/llm.js';
import { recordStrategyHit, type StrategyHit } from './lib/metrics.js';
import type { HeuristicExtraction } from './lib/extractors.js';
import type { Recipe } from './lib/recipe-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

const validateUrl = (value: unknown): string | null => {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const hasStructuredBits = (
  result: HeuristicExtraction | Recipe | null | undefined,
): result is HeuristicExtraction | Recipe =>
  (result?.ingredients?.length || 0) > 0 && (result?.steps?.length || 0) > 0;

const isRecipeComplete = (
  recipe: Recipe | null | undefined,
): recipe is Recipe =>
  Boolean(recipe) &&
  (recipe.ingredients?.length || 0) > 0 &&
  (recipe.steps?.length || 0) > 0;

const shouldEnrich = (recipe: Recipe): boolean => {
  const missingTitle = !recipe.title;
  const missingDescription = !recipe.description;
  const missingTotal = recipe.time.total == null;
  const missingServings =
    recipe.yield.servings == null && !recipe.yield.original;
  const missingTags = recipe.tags.length === 0;
  return (
    missingTitle ||
    missingDescription ||
    missingTotal ||
    missingServings ||
    missingTags
  );
};

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const DEFAULT_TIMEOUT_MS = 12_000;

app.get('/health', (_req: Request, res: Response) => {
  res.type('text/plain').send('Recipe Scraper PoC is running.');
});

type IngestBody = { url?: string };

app.post(
  '/ingest',
  async (req: Request<unknown, unknown, IngestBody>, res: Response) => {
    const safeUrl = validateUrl(req.body?.url ?? null);
    if (!safeUrl) {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'url' in body" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(safeUrl, {
        headers: {
          'user-agent':
            'RecipeScrapePoC/0.2 (+https://example.com; for personal use)',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(502).json({
          error: `Fetch failed: ${response.status} ${response.statusText}`,
        });
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      const heuristics = extractHeuristics($);
      let enrichmentHeuristics: HeuristicExtraction | null = heuristics;
      const readable = extractReadableContent(html, safeUrl);

      let recipe: Recipe | null = null;
      let strategy: StrategyHit | null = null;
      let enriched = false;

      const maybeEnrich = async (base: Recipe): Promise<Recipe> => {
        if (!shouldEnrich(base)) return base;
        const enrichedRecipe = await llmEnrichRecipe({
          base,
          html,
          heuristics: enrichmentHeuristics ?? undefined,
          readableHtml: readable,
        });
        if (enrichedRecipe) {
          recordStrategyHit('llm-enrich');
          enriched = true;
          return enrichedRecipe;
        }
        return base;
      };

      const jsonld = extractJSONLDRecipe($);
      if (jsonld) {
        try {
          const normalized = normalizeFromJSONLD(jsonld, safeUrl);
          recipe = normalized;
          strategy = 'json-ld';
        } catch (err) {
          console.warn('[json-ld normalize error]', getErrorMessage(err));
        }
      }

      if (!isRecipeComplete(recipe)) {
        const microdata = extractMicrodataRecipe($);
        if (microdata) {
          try {
            const normalized = normalizeFromJSONLD(microdata, safeUrl);
            recipe = normalized;
            strategy = 'microdata';
          } catch (err) {
            console.warn('[microdata normalize error]', getErrorMessage(err));
          }
        }
      }

      if (!isRecipeComplete(recipe) && hasStructuredBits(heuristics)) {
        try {
          recipe = normalizeFromHeuristics(heuristics, safeUrl);
          strategy = 'heuristics';
        } catch (err) {
          console.warn('[heuristics normalize error]', getErrorMessage(err));
        }
      }

      if (!isRecipeComplete(recipe) && readable) {
        const readable$ = cheerio.load(readable);
        const readableFallback = extractHeuristics(readable$);
        if (hasStructuredBits(readableFallback)) {
          try {
            recipe = normalizeFromHeuristics(readableFallback, safeUrl);
            enrichmentHeuristics = readableFallback;
            strategy = 'readability-heuristics';
          } catch (err) {
            console.warn(
              '[readability heuristics normalize error]',
              getErrorMessage(err),
            );
          }
        }
      }

      if (!isRecipeComplete(recipe)) {
        const llmRecipe = await llmExtractFromHtml({
          url: safeUrl,
          html,
          heuristics: enrichmentHeuristics ?? heuristics,
          readableHtml: readable,
        });
        if (isRecipeComplete(llmRecipe)) {
          recipe = llmRecipe;
          strategy = 'llm-fallback';
        }
      }

      if (!recipe) {
        return res.status(422).json({
          ok: false,
          error:
            'Could not extract a recipe. Try another URL or consider adding an LLM fallback.',
        });
      }

      if (strategy !== 'llm-fallback') {
        recipe = await maybeEnrich(recipe);
      }

      if (strategy) {
        recordStrategyHit(strategy);
      }

      return res.json({
        ok: true,
        strategy,
        llmEnriched: enriched,
        recipe,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        return res.status(504).json({ error: 'Upstream fetch timed out' });
      }
      console.error(err);
      return res
        .status(500)
        .json({ error: 'Server error', detail: getErrorMessage(err) });
    }
  },
);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Recipe Scraper PoC listening on http://localhost:${PORT}`);
});
