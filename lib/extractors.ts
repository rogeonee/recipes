import type { CheerioAPI } from 'cheerio';

const TYPE_RECIPE_RE = /schema\.org\/recipe/i;

export type StructuredRecipeNode = Record<string, unknown>;

export type HeuristicExtraction = {
  title: string | null;
  image: string | null;
  ingredients: string[];
  steps: string[];
};

type ElementNode = {
  attribs?: Record<string, string | undefined>;
  name?: string;
  children?: ElementNode[];
  type?: string;
};

const simplifyTypes = (typeAttr: string): string[] =>
  typeAttr
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const parts = t.split('/');
      return parts[parts.length - 1] || t;
    });

function collectItemscope(
  $: CheerioAPI,
  scopeEl: ElementNode,
): StructuredRecipeNode {
  const typeAttr = scopeEl.attribs?.itemtype ?? '';
  const types = simplifyTypes(typeAttr);
  const data: StructuredRecipeNode = {};
  if (types.length) {
    data['@type'] = types.length === 1 ? types[0] : types;
  }

  const addValue = (prop: string, value: unknown) => {
    if (value == null) return;
    const existing = data[prop];
    if (existing === undefined) {
      data[prop] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      data[prop] = [existing, value];
    }
  };

  const readValue = (
    node: ElementNode,
  ): string | StructuredRecipeNode | null => {
    const attribs = node.attribs ?? {};
    const name = node.name?.toLowerCase() ?? '';
    if (attribs.content) return attribs.content.trim();
    if (name === 'meta') return attribs.content?.trim() ?? null;
    if (name === 'time')
      return (
        attribs.datetime ??
        $(node as any)
          .text()
          .trim()
      );
    if (name === 'link') return attribs.href ?? null;
    if (['img', 'source'].includes(name)) return attribs.src ?? null;
    if (attribs.href && ['a', 'area'].includes(name)) return attribs.href;
    const text = $(node as any)
      .text()
      .trim();
    return text || null;
  };

  const traverse = (node: ElementNode | null | undefined) => {
    if (!node?.children) return;
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      const element = child as ElementNode;
      const prop = element.attribs?.itemprop;
      const hasScope = 'itemscope' in (element.attribs || {});
      if (prop) {
        const value = hasScope
          ? collectItemscope($, element)
          : readValue(element);
        addValue(prop, value);
      }
      if (!hasScope) traverse(element);
    }
  };

  traverse(scopeEl);

  if (
    Array.isArray(data['@type'])
      ? data['@type'].some((t) => /recipe/i.test(t))
      : /recipe/i.test(String(data['@type'] || ''))
  ) {
    if (Array.isArray(data['@type'])) {
      data['@type'] =
        data['@type'].find((t) => /recipe/i.test(t)) || data['@type'][0];
    }
  }

  return data;
}

export function extractJSONLDRecipe(
  $: CheerioAPI,
): StructuredRecipeNode | null {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const json = JSON.parse(raw);
      blocks.push(json);
    } catch {
      /* swallow malformed blocks */
    }
  });

  const collect = (node: unknown): StructuredRecipeNode[] => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    if (typeof node === 'object') {
      const obj = node as StructuredRecipeNode;
      const typeRaw = obj['@type'];
      const types = Array.isArray(typeRaw) ? typeRaw : typeRaw ? [typeRaw] : [];
      const isRecipe = types?.some?.((t) =>
        String(t).toLowerCase().includes('recipe'),
      );
      const graphRaw = obj['@graph'];
      const inGraph = Array.isArray(graphRaw)
        ? (graphRaw as unknown[]).flatMap(collect)
        : [];
      const children = Object.values(obj).flatMap(collect);
      return (isRecipe ? [obj] : []).concat(inGraph, children);
    }
    return [];
  };

  const recipes = blocks.flatMap(collect);
  return recipes[0] || null;
}

export function extractMicrodataRecipe(
  $: CheerioAPI,
): StructuredRecipeNode | null {
  const scopes = $('[itemscope][itemtype]');
  for (const el of scopes.toArray() as ElementNode[]) {
    const typeAttr = el.attribs?.itemtype ?? '';
    if (!TYPE_RECIPE_RE.test(typeAttr)) continue;
    const recipe = collectItemscope($, el);
    if (recipe) return recipe;
  }
  return null;
}

export function extractHeuristics($: CheerioAPI): HeuristicExtraction {
  const title =
    $('h1[itemprop="name"]').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    null;

  const ingredientCandidates = [
    '[itemprop="recipeIngredient"]',
    '.ingredients li',
    '.ingredient-list li',
    '.ingredient-item',
    '.recipe-ingredients li',
    '.ingredients p',
  ];
  let ingredients: string[] = [];
  for (const sel of ingredientCandidates) {
    const list = $(sel)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (list.length >= 2) {
      ingredients = list;
      break;
    }
  }

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
  let stepsText: string[] = [];
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

  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const firstImg = $('img').attr('src') || null;

  return {
    title,
    image: ogImage || firstImg || null,
    ingredients,
    steps: stepsText,
  };
}
