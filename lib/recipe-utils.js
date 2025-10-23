import he from 'he';

export const decode = (s) => (typeof s === 'string' ? he.decode(s) : s);

export const minutesFromISO8601Duration = (dur) => {
  const pick = Array.isArray(dur)
    ? dur.find((s) => typeof s === 'string' && /P(T|$)/i.test(s))
    : dur;
  if (!pick || typeof pick !== 'string') return null;
  const m = pick.match(
    /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/i,
  );
  if (!m) return null;
  const weeks = m[1] ? parseInt(m[1], 10) : 0;
  const days = m[2] ? parseInt(m[2], 10) : 0;
  const hours = m[3] ? parseInt(m[3], 10) : 0;
  const minutes = m[4] ? parseInt(m[4], 10) : 0;
  const seconds = m[5] ? parseInt(m[5], 10) : 0;
  return (
    weeks * 7 * 24 * 60 +
    days * 24 * 60 +
    hours * 60 +
    minutes +
    Math.round(seconds / 60)
  );
};

export const toStringCoerce = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
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

export const toStringArray = (v) => {
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
  if (typeof v === 'string') {
    return v
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
};

export const clampInt = (n) =>
  Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;

export const getDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

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
  ['lbs', 'lb'],
  ['pound', 'lb'],
  ['pounds', 'lb'],
  ['clove', 'clove'],
  ['cloves', 'clove'],
  ['can', 'can'],
  ['cans', 'can'],
  ['pinch', 'pinch'],
  ['pinches', 'pinch'],
  ['bunch', 'bunch'],
  ['bunches', 'bunch'],
  ['slice', 'slice'],
  ['slices', 'slice'],
]);

const normalizeUnit = (u) => {
  if (!u) return null;
  const key = u.toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES.get(key) || key;
};

export function parseIngredientLine(line) {
  const original = decode(line.trim().replace(/\s+/g, ' '));
  if (!original) return null;

  const qtyMatch = original.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/);
  let quantity = null;
  let rest = original;
  if (qtyMatch) {
    const q = qtyMatch[1];
    if (q.includes('/')) {
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
    rest = rest.slice(qtyMatch[0].length).trim();
  }

  let unit = null;
  let item = rest;
  let note = null;

  if (rest) {
    const tokMatch = rest.match(/^([a-zA-Z\.]+)\b/);
    if (tokMatch) {
      const maybeUnitRaw = tokMatch[1];
      const maybeUnit = normalizeUnit(maybeUnitRaw);
      if (
        UNIT_ALIASES.has(maybeUnitRaw.toLowerCase().replace(/\.$/, '')) ||
        [
          'g',
          'kg',
          'ml',
          'l',
          'cup',
          'oz',
          'lb',
          'tsp',
          'tbsp',
          'clove',
          'can',
          'pinch',
          'bunch',
          'slice',
        ].includes(maybeUnit)
      ) {
        unit = maybeUnit;
        item = rest.slice(tokMatch[0].length).trim();
      }
    }
  }

  if (item) {
    const comma = item.indexOf(',');
    if (comma !== -1) {
      note = item.slice(comma + 1).trim() || null;
      item = item.slice(0, comma).trim();
    }
  }

  if (item && /^of\s+/i.test(item)) item = item.replace(/^of\s+/i, '');

  return {
    original,
    quantity: quantity ?? null,
    unit: unit ?? null,
    item: item || null,
    note: note || null,
  };
}

export const isShoutyHeading = (s) => {
  if (!s) return false;
  const t = s.trim();
  const words = t.split(/\s+/);
  if (words.length <= 4) {
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters && letters === letters.toUpperCase()) return true;
  }
  return /^for the\b/i.test(t) || /^serv(e|ing)s\b/i.test(t);
};

export function normalizeSteps(arr) {
  const steps = (arr || [])
    .map((s) => (typeof s === 'string' ? s : s?.text || ''))
    .map((s) => decode(s.trim()))
    .filter(Boolean)
    .filter((s) => !isShoutyHeading(s))
    .map((text, i) => ({ n: i + 1, text }));
  return steps;
}
