// server.js
import express from 'express';
import morgan from 'morgan';
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { z } from 'zod';

// ---------- Tiny recipe schema (what we return) ----------
const RecipeSchema = z.object({
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  image: z.string().optional().nullable(),
  author: z.string().optional().nullable(),
  yield: z.object({
    servings: z.number().optional().nullable(),
    original: z.string().optional().nullable(),
  }),
  time: z.object({
    prep: z.number().optional().nullable(), // minutes
    cook: z.number().optional().nullable(), // minutes
    total: z.number().optional().nullable(), // minutes
  }),
  ingredients: z.array(
    z.object({
      original: z.string(),
      quantity: z.number().optional().nullable(),
      unit: z.string().optional().nullable(),
      item: z.string().optional().nullable(),
      note: z.string().optional().nullable(),
    }),
  ),
  steps: z.array(
    z.object({
      n: z.number(),
      text: z.string(),
    }),
  ),
  tags: z.array(z.string()),
  dietFlags: z
    .object({
      vegan: z.boolean().optional(),
      vegetarian: z.boolean().optional(),
      glutenFree: z.boolean().optional(),
      dairyFree: z.boolean().optional(),
    })
    .partial(),
  units: z.enum(['metric', 'us']).optional().default('metric'),
  source: z.object({
    url: z.string(),
    domain: z.string().optional(),
    fetchedAt: z.string(),
  }),
  llmNotes: z.any().optional().nullable(),
});

// ---------- Utils ----------
const minutesFromISO8601Duration = (dur) => {
  // Accept string or array of strings (take the first ISO8601-looking value)
  const pick = Array.isArray(dur)
    ? dur.find((s) => typeof s === 'string' && /P(T|$)/i.test(s))
    : dur;
  if (!pick || typeof pick !== 'string') return null;
  const m = pick.match(/P(T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/i);
  if (!m) return null;
  const h = m[2] ? parseInt(m[2], 10) : 0;
  const min = m[3] ? parseInt(m[3], 10) : 0;
  const s = m[4] ? parseInt(m[4], 10) : 0;
  return h * 60 + min + Math.round(s / 60);
};

const toStringCoerce = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    // Join stringy parts or common fields
    const parts = v
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') return x.name || x.text || '';
        return '';
      })
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (typeof v === 'object') return v.name || v.text || null;
  return null;
};

const toStringArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .flatMap((x) => {
        if (typeof x === 'string') return [x];
        if (x && typeof x === 'object') return [x.text || x.name || ''];
        return [];
      })
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof v === 'string')
    return v
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
};

const clampInt = (n) =>
  Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;

const getDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

// very small units list to normalize e.g. "tbs", "tbsp." → "tbsp"
const UNIT_ALIASES = new Map([
  ['t', 'tsp'],
  ['ts', 'tsp'],
  ['tsp.', 'tsp'],
  ['teaspoon', 'tsp'],
  ['teaspoons', 'tsp'],
  ['tbsp.', 'tbsp'],
  ['tbs', 'tbsp'],
  ['tablespoon', 'tbsp'],
  ['tablespoons', 'tbsp'],
  ['g', 'g'],
  ['gram', 'g'],
  ['grams', 'g'],
  ['kg', 'kg'],
  ['kilogram', 'kg'],
  ['kilograms', 'kg'],
  ['ml', 'ml'],
  ['milliliter', 'ml'],
  ['milliliters', 'ml'],
  ['l', 'l'],
  ['liter', 'l'],
  ['liters', 'l'],
  ['cup', 'cup'],
  ['cups', 'cup'],
  ['oz', 'oz'],
  ['ounce', 'oz'],
  ['ounces', 'oz'],
  ['lb', 'lb'],
  ['pound', 'lb'],
  ['pounds', 'lb'],
]);

const normalizeUnit = (u) => {
  if (!u) return null;
  const key = u.toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES.get(key) || u;
};

// Parse an ingredient line like "1 1/2 cups flour" or "2 tbsp olive oil, divided"
function parseIngredientLine(line) {
  const original = line.trim().replace(/\s+/g, ' ');
  if (!original) return null;

  // capture mixed fractions (e.g. 1 1/2), simple fractions (1/2), or decimals
  const qtyMatch = original.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(\.\d+)?)/);
  let quantity = null;
  let rest = original;
  if (qtyMatch) {
    const q = qtyMatch[1];
    if (q.includes('/')) {
      // "1 1/2" or "1/2"
      const parts = q.split(' ');
      if (parts.length === 2) {
        const whole = parseFloat(parts[0]);
        const [num, den] = parts[1].split('/').map(Number);
        quantity = whole + num / den;
      } else {
        const [num, den] = q.split('/').map(Number);
        quantity = num / den;
      }
    } else {
      quantity = parseFloat(q);
    }
    rest = original.slice(qtyMatch[0].length).trim();
  }

  // try to read a unit next
  const unitMatch = rest.match(/^([a-zA-Z\.]+)\b/);
  let unit = null;
  if (unitMatch) {
    unit = normalizeUnit(unitMatch[1]);
    // Only treat it as a unit if it’s a known/likely one (basic heuristic)
    if (
      !UNIT_ALIASES.has(unitMatch[1].toLowerCase().replace(/\.$/, '')) &&
      ![
        'g',
        'kg',
        'ml',
        'l',
        'cup',
        'cups',
        'oz',
        'lb',
        'tsp',
        'tbsp',
      ].includes(unit)
    ) {
      unit = null; // probably part of the item (e.g., "large")
    } else {
      rest = rest.slice(unitMatch[0].length).trim();
    }
  }

  // split trailing note by comma "olive oil, divided"
  let item = rest;
  let note = null;
  const comma = rest.indexOf(',');
  if (comma !== -1) {
    item = rest.slice(0, comma).trim();
    note = rest.slice(comma + 1).trim();
  }

  return {
    original,
    quantity: quantity ?? null,
    unit: unit ?? null,
    item: item || null,
    note: note || null,
  };
}

// Make steps numbered, trimmed
function normalizeSteps(arr) {
  const steps = (arr || [])
    .map((s) => (typeof s === 'string' ? s : s?.text || ''))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text, i) => ({ n: i + 1, text }));
  return steps;
}

// Try extracting JSON-LD recipes from <script type="application/ld+json">
function extractJSONLDRecipe($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const json = JSON.parse(raw);
      blocks.push(json);
    } catch {
      /* ignore malformed blocks */
    }
  });

  const collect = (node) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    if (typeof node === 'object') {
      const types = Array.isArray(node['@type'])
        ? node['@type']
        : [node['@type']];
      const isRecipe = types?.includes?.('Recipe');
      const inGraph = Array.isArray(node['@graph'])
        ? node['@graph'].flatMap(collect)
        : [];
      const children = Object.values(node).flatMap(collect);
      return (isRecipe ? [node] : []).concat(inGraph, children);
    }
    return [];
  };

  const recipes = blocks.flatMap(collect);
  return recipes[0] || null;
}

// Fallback heuristics (common selectors)
function extractHeuristics($) {
  const title =
    $('h1[itemprop="name"]').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    null;

  // Ingredients (common patterns)
  const ingredientCandidates = [
    '[itemprop="recipeIngredient"]',
    '.ingredients li',
    '.ingredient-list li',
    '.ingredient-item',
    '.recipe-ingredients li',
    '.ingredients p',
  ];
  let ingredients = [];
  for (const sel of ingredientCandidates) {
    const list = $(sel)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (list.length >= 2) {
      ingredients = list;
      break;
    } // take the first plausible list
  }

  // Steps / instructions
  const stepCandidates = [
    '[itemprop="recipeInstructions"] li',
    '[itemprop="recipeInstructions"] p',
    '.instructions li',
    '.instructions p',
    '.method li',
    '.method p',
    '.directions li',
    '.directions p',
    '.recipe-steps li',
    '.recipe-steps p',
  ];
  let stepsText = [];
  for (const sel of stepCandidates) {
    const list = $(sel)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (list.length >= 1) {
      stepsText = list;
      break;
    }
  }

  // Image (best guess)
  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const firstImg = $('img').attr('src') || null;

  return {
    title,
    image: ogImage || firstImg || null,
    ingredients,
    steps: stepsText,
  };
}

// Normalize a JSON-LD recipe object to our schema
function normalizeFromJSONLD(obj, sourceUrl) {
  const title = toStringCoerce(obj.name);
  const description = toStringCoerce(obj.description);

  // image can be string | {url} | string[] | object[]
  let image = null;
  const imgRaw = obj.image;
  if (Array.isArray(imgRaw)) {
    const first = imgRaw[0];
    image = typeof first === 'string' ? first : first?.url || null;
  } else if (typeof imgRaw === 'string') {
    image = imgRaw;
  } else if (imgRaw && typeof imgRaw === 'object') {
    image = imgRaw.url || null;
  }

  // author can be string | {name} | array
  let author = null;
  if (typeof obj.author === 'string') author = obj.author;
  else if (Array.isArray(obj.author)) author = obj.author[0]?.name || null;
  else if (obj.author && typeof obj.author === 'object')
    author = obj.author.name || null;

  // recipeYield can be number | string | array | object
  const yieldOriginal = toStringCoerce(obj.recipeYield);
  let servings = null;
  if (typeof obj.recipeYield === 'number') {
    servings = obj.recipeYield;
  } else {
    const m = toStringCoerce(obj.recipeYield)?.match(
      /(\d+)\s*(servings|serves|portion|portions)?/i,
    );
    if (m) servings = parseInt(m[1], 10);
  }

  // times accept string or array
  const prep = minutesFromISO8601Duration(obj.prepTime) ?? null;
  const cook = minutesFromISO8601Duration(obj.cookTime) ?? null;
  const total =
    minutesFromISO8601Duration(obj.totalTime) ??
    ((prep ?? 0) + (cook ?? 0) || null);

  // instructions may be:
  // - string with newlines
  // - array of strings
  // - array of HowToStep objects ({text|name})
  // - array of HowToSection objects ({itemListElement:[HowToStep...]})
  let stepStrings = [];
  const inst = obj.recipeInstructions;
  if (typeof inst === 'string') {
    stepStrings = inst
      .split(/\n+|\r+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(inst)) {
    const collect = [];
    for (const step of inst) {
      if (typeof step === 'string') {
        collect.push(step);
      } else if (step && typeof step === 'object') {
        const t = step.text || step.name;
        if (t) collect.push(t);
        // HowToSection support
        const list = Array.isArray(step.itemListElement)
          ? step.itemListElement
          : [];
        for (const li of list) {
          if (typeof li === 'string') collect.push(li);
          else if (li && typeof li === 'object') {
            const lt = li.text || li.name;
            if (lt) collect.push(lt);
          }
        }
      }
    }
    stepStrings = collect.filter(Boolean);
  }

  // ingredients are typically in recipeIngredient, but some sites use "ingredients"
  const ingStrings = Array.isArray(obj.recipeIngredient)
    ? obj.recipeIngredient
    : Array.isArray(obj.ingredients)
    ? obj.ingredients
    : [];

  const ingredients = ingStrings
    .map((s) => parseIngredientLine(String(s)))
    .filter(Boolean);

  const steps = normalizeSteps(stepStrings);

  // tags from keywords/category/cuisine; each can be string | array
  const tags = [
    ...toStringArray(obj.keywords),
    ...toStringArray(obj.recipeCategory),
    ...toStringArray(obj.recipeCuisine),
  ].map((s) => s.toLowerCase());

  return RecipeSchema.parse({
    title: title || null,
    description: description || null,
    image: image || null,
    author: author || null,
    yield: { servings: servings ?? null, original: yieldOriginal || null },
    time: {
      prep: clampInt(prep),
      cook: clampInt(cook),
      total: clampInt(total),
    },
    ingredients,
    steps,
    tags,
    dietFlags: {},
    units: 'metric',
    source: {
      url: sourceUrl,
      domain: getDomain(sourceUrl),
      fetchedAt: new Date().toISOString(),
    },
    llmNotes: null,
  });
}

// Normalize from heuristic extraction
function normalizeFromHeuristics(data, sourceUrl) {
  const {
    title,
    image,
    ingredients: ingStrings = [],
    steps: stepStrings = [],
  } = data;
  const ingredients = ingStrings
    .map((s) => parseIngredientLine(String(s)))
    .filter(Boolean);
  const steps = normalizeSteps(stepStrings);

  return RecipeSchema.parse({
    title: title || null,
    description: null,
    image: image || null,
    author: null,
    yield: { servings: null, original: null },
    time: { prep: null, cook: null, total: null },
    ingredients,
    steps,
    tags: [],
    dietFlags: {},
    units: 'metric',
    source: {
      url: sourceUrl,
      domain: getDomain(sourceUrl),
      fetchedAt: new Date().toISOString(),
    },
    llmNotes: { extracted: 'heuristics' },
  });
}

// ---------- Express app ----------
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(morgan('dev'));

// Simple health check
app.get('/', (req, res) => {
  res.type('text/plain').send('Recipe Scraper PoC is running.');
});

// Ingest endpoint
app.post('/ingest', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in body" });

  try {
    // (PoC!) In production: respect robots.txt and site ToS, add caching, retry, and backoff.
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'RecipeScrapePoC/0.1 (+https://example.com; for personal use)',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      return res.status(502).json({
        error: `Fetch failed: ${response.status} ${response.statusText}`,
      });
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    // 1) JSON-LD first
    const jsonld = extractJSONLDRecipe($);
    if (jsonld) {
      try {
        const normalized = normalizeFromJSONLD(jsonld, url);
        return res.json({ ok: true, strategy: 'json-ld', recipe: normalized });
      } catch (e) {
        // fall through to heuristics if JSON-LD is malformed/incomplete
        console.warn('[JSON-LD normalize error]', e?.message || e);
      }
    }

    // 2) Heuristics
    const fallback = extractHeuristics($);
    if (
      (fallback.ingredients?.length || 0) > 0 &&
      (fallback.steps?.length || 0) > 0
    ) {
      const normalized = normalizeFromHeuristics(fallback, url);
      return res.json({ ok: true, strategy: 'heuristics', recipe: normalized });
    }

    // If nothing usable
    return res.status(422).json({
      ok: false,
      error: 'Could not extract a recipe. Try another URL or add LLM fallback.',
    });
  } catch (err) {
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
