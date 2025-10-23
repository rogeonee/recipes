// server.js
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
import * as cheerio from 'cheerio';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

const validateUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const hasStructuredBits = (result) =>
  (result?.ingredients?.length || 0) > 0 &&
  (result?.steps?.length || 0) > 0;

const DEFAULT_TIMEOUT_MS = 12_000;

app.get('/health', (req, res) => {
  res.type('text/plain').send('Recipe Scraper PoC is running.');
});

app.post('/ingest', async (req, res) => {
  const safeUrl = validateUrl(req.body?.url);
  if (!safeUrl) {
    return res.status(400).json({ error: "Missing or invalid 'url' in body" });
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

    const jsonld = extractJSONLDRecipe($);
    if (jsonld) {
      try {
        const normalized = normalizeFromJSONLD(jsonld, safeUrl);
        return res.json({
          ok: true,
          strategy: 'json-ld',
          recipe: normalized,
        });
      } catch (err) {
        console.warn('[json-ld normalize error]', err?.message || err);
      }
    }

    const microdata = extractMicrodataRecipe($);
    if (microdata) {
      try {
        const normalized = normalizeFromJSONLD(microdata, safeUrl);
        return res.json({
          ok: true,
          strategy: 'microdata',
          recipe: normalized,
        });
      } catch (err) {
        console.warn('[microdata normalize error]', err?.message || err);
      }
    }

    const fallback = extractHeuristics($);
    if (hasStructuredBits(fallback)) {
      try {
        const normalized = normalizeFromHeuristics(fallback, safeUrl);
        return res.json({
          ok: true,
          strategy: 'heuristics',
          recipe: normalized,
        });
      } catch (err) {
        console.warn('[heuristics normalize error]', err?.message || err);
      }
    }

    const readable = extractReadableContent(html, safeUrl);
    if (readable) {
      const readable$ = cheerio.load(readable);
      const readableFallback = extractHeuristics(readable$);
      if (hasStructuredBits(readableFallback)) {
        try {
          const normalized = normalizeFromHeuristics(
            readableFallback,
            safeUrl,
          );
          return res.json({
            ok: true,
            strategy: 'readability-heuristics',
            recipe: normalized,
          });
        } catch (err) {
          console.warn(
            '[readability heuristics normalize error]',
            err?.message || err,
          );
        }
      }
    }

    return res.status(422).json({
      ok: false,
      error:
        'Could not extract a recipe. Try another URL or consider adding an LLM fallback.',
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream fetch timed out' });
    }
    console.error(err);
    return res
      .status(500)
      .json({ error: 'Server error', detail: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Recipe Scraper PoC listening on http://localhost:${PORT}`);
});
