import { RecipeSchema } from './recipe-schema.js';
import type { Ingredient, Recipe } from './recipe-schema.js';
import type {
  HeuristicExtraction,
  StructuredRecipeNode,
} from './extractors.js';
import {
  clampInt,
  decode,
  getDomain,
  minutesFromISO8601Duration,
  normalizeSteps,
  parseIngredientLine,
  toStringArray,
  toStringCoerce,
} from './recipe-utils.js';

const METRIC_UNITS = new Set<string>(['g', 'kg', 'ml', 'l']);
const US_UNITS = new Set<string>(['cup', 'oz', 'lb']);
const NEUTRAL_UNITS = new Set<string>([
  'tsp',
  'tbsp',
  'pinch',
  'bunch',
  'slice',
  'clove',
  'can',
]);

export const inferUnitsFromIngredients = (
  ingredients: Ingredient[],
): 'metric' | 'us' => {
  const units = ingredients
    .map((ing) => ing.unit)
    .filter(Boolean)
    .map((u) => u!.toLowerCase());
  if (units.length === 0) return 'metric';

  const metricOnly = units.every(
    (unit) => METRIC_UNITS.has(unit) || NEUTRAL_UNITS.has(unit),
  );
  const usOnly = units.every(
    (unit) => US_UNITS.has(unit) || NEUTRAL_UNITS.has(unit),
  );

  if (metricOnly && !usOnly) return 'metric';
  if (usOnly && !metricOnly) return 'us';
  return 'metric';
};

export function normalizeFromJSONLD(
  obj: StructuredRecipeNode,
  sourceUrl: string,
): Recipe {
  const title = decode(toStringCoerce(obj['name']));
  const description = decode(toStringCoerce(obj['description']));

  let image = null;
  const imgRaw = obj['image'];
  if (Array.isArray(imgRaw)) {
    const first = imgRaw[0];
    image =
      typeof first === 'string'
        ? first
        : (first as StructuredRecipeNode | undefined)?.url || null;
  } else if (typeof imgRaw === 'string') {
    image = imgRaw;
  } else if (imgRaw && typeof imgRaw === 'object') {
    image = (imgRaw as StructuredRecipeNode).url || null;
  }

  let author = null;
  const authorRaw = obj['author'];
  if (typeof authorRaw === 'string') author = authorRaw;
  else if (Array.isArray(authorRaw))
    author = (authorRaw[0] as StructuredRecipeNode | undefined)?.name || null;
  else if (authorRaw && typeof authorRaw === 'object')
    author = (authorRaw as StructuredRecipeNode).name || null;

  const rawYield = toStringCoerce(obj['recipeYield']);
  const yieldOriginal = rawYield
    ? rawYield.replace(/\b(\d+)\s+\1\b/, '$1').trim()
    : null;

  let servings = null;
  if (typeof obj['recipeYield'] === 'number') {
    servings = obj['recipeYield'];
  } else {
    const m = yieldOriginal?.match(
      /(\d+)\s*(servings?|serves?|people|portion|portions)?/i,
    );
    if (m) servings = parseInt(m[1], 10);
  }

  const prep = minutesFromISO8601Duration(obj['prepTime']) ?? null;
  const cook = minutesFromISO8601Duration(obj['cookTime']) ?? null;
  const total =
    minutesFromISO8601Duration(obj['totalTime']) ??
    ((prep ?? 0) + (cook ?? 0) || null);

  let stepStrings: string[] = [];
  const inst = obj['recipeInstructions'];
  if (typeof inst === 'string') {
    stepStrings = inst
      .split(/\n+|\r+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(inst)) {
    const collect: string[] = [];
    for (const step of inst) {
      if (typeof step === 'string') {
        collect.push(step);
      } else if (step && typeof step === 'object') {
        const node = step as StructuredRecipeNode;
        const t =
          (node.text as string | undefined) ??
          (node.name as string | undefined);
        if (t) collect.push(t);
        const list = Array.isArray(node.itemListElement)
          ? (node.itemListElement as unknown[])
          : [];
        for (const li of list) {
          if (typeof li === 'string') collect.push(li);
          else if (li && typeof li === 'object') {
            const liNode = li as StructuredRecipeNode;
            const lt =
              (liNode.text as string | undefined) ??
              (liNode.name as string | undefined);
            if (lt) collect.push(lt);
          }
        }
      }
    }
    stepStrings = collect.filter(Boolean);
  }

  const ingStrings = Array.isArray(obj['recipeIngredient'])
    ? obj['recipeIngredient']
    : Array.isArray(obj['ingredients'])
    ? obj['ingredients']
    : [];

  const ingredients = ingStrings
    .map((s) => parseIngredientLine(String(s)))
    .filter((ing): ing is Ingredient => Boolean(ing));

  const steps = normalizeSteps(stepStrings);

  const tags = [
    ...toStringArray(obj['keywords']),
    ...toStringArray(obj['recipeCategory']),
    ...toStringArray(obj['recipeCuisine']),
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
    units: inferUnitsFromIngredients(ingredients),
    source: {
      url: sourceUrl,
      domain: getDomain(sourceUrl),
      fetchedAt: new Date().toISOString(),
    },
    llmNotes: null,
  });
}

export function normalizeFromHeuristics(
  data: HeuristicExtraction,
  sourceUrl: string,
): Recipe {
  const {
    title,
    image,
    ingredients: ingStrings = [],
    steps: stepStrings = [],
  } = data;
  const ingredients = ingStrings
    .map((s) => parseIngredientLine(String(s)))
    .filter((ing): ing is Ingredient => Boolean(ing));
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
    units: inferUnitsFromIngredients(ingredients),
    source: {
      url: sourceUrl,
      domain: getDomain(sourceUrl),
      fetchedAt: new Date().toISOString(),
    },
    llmNotes: { extracted: 'heuristics' },
  });
}
