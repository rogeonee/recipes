const TYPE_RECIPE_RE = /schema\.org\/recipe/i;

const simplifyTypes = (typeAttr) =>
  typeAttr
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const parts = t.split('/');
      return parts[parts.length - 1] || t;
    });

function collectItemscope($, scopeEl) {
  const typeAttr = scopeEl.attribs?.itemtype || '';
  const types = simplifyTypes(typeAttr);
  const data = {};
  if (types.length) {
    data['@type'] = types.length === 1 ? types[0] : types;
  }

  const addValue = (prop, value) => {
    if (value == null) return;
    if (data[prop] === undefined) {
      data[prop] = value;
    } else if (Array.isArray(data[prop])) {
      data[prop].push(value);
    } else {
      data[prop] = [data[prop], value];
    }
  };

  const readValue = (node) => {
    const attribs = node.attribs || {};
    const name = node.name?.toLowerCase() || '';
    if (attribs.content) return attribs.content.trim();
    if (name === 'meta') return attribs.content?.trim() ?? null;
    if (name === 'time') return attribs.datetime || $(node).text().trim();
    if (name === 'link') return attribs.href || null;
    if (['img', 'source'].includes(name)) return attribs.src || null;
    if (attribs.href && ['a', 'area'].includes(name)) return attribs.href;
    const text = $(node).text().trim();
    return text || null;
  };

  const traverse = (node) => {
    if (!node || !node.children) return;
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      const prop = child.attribs?.itemprop;
      const hasScope = 'itemscope' in (child.attribs || {});
      if (prop) {
        const value = hasScope
          ? collectItemscope($, child)
          : readValue(child);
        addValue(prop, value);
      }
      if (!hasScope) traverse(child);
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

export function extractJSONLDRecipe($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const json = JSON.parse(raw);
      blocks.push(json);
    } catch {
      /* swallow malformed blocks */
    }
  });

  const collect = (node) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    if (typeof node === 'object') {
      const types = Array.isArray(node['@type'])
        ? node['@type']
        : node['@type']
        ? [node['@type']]
        : [];
      const isRecipe = types?.some?.((t) =>
        String(t).toLowerCase().includes('recipe'),
      );
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

export function extractMicrodataRecipe($) {
  const scopes = $('[itemscope][itemtype]');
  for (const el of scopes.toArray()) {
    const typeAttr = el.attribs?.itemtype || '';
    if (!TYPE_RECIPE_RE.test(typeAttr)) continue;
    const recipe = collectItemscope($, el);
    if (recipe) return recipe;
  }
  return null;
}

export function extractHeuristics($) {
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
  let ingredients = [];
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

  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const firstImg = $('img').attr('src') || null;

  return {
    title,
    image: ogImage || firstImg || null,
    ingredients,
    steps: stepsText,
  };
}
