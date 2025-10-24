import he from 'he';
import type { Ingredient, Recipe } from './recipe-schema.js';

export const decode = <T>(s: T): T | string =>
  typeof s === 'string' ? he.decode(s) : s;

export const minutesFromISO8601Duration = (dur: unknown): number | null => {
  const pick = Array.isArray(dur)
    ? dur.find((s): s is string => typeof s === 'string' && /P(T|$)/i.test(s))
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

export const toStringCoerce = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') {
          const node = x as Record<string, unknown>;
          const byName = node.name;
          if (typeof byName === 'string') return byName;
          const byText = node.text;
          if (typeof byText === 'string') return byText;
        }
        return '';
      })
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const byName = obj.name;
    if (typeof byName === 'string') return byName;
    const byText = obj.text;
    if (typeof byText === 'string') return byText;
    return null;
  }
  return null;
};

export const toStringArray = (v: unknown): string[] => {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .flatMap((x) => {
        if (typeof x === 'string') return [x];
        if (x && typeof x === 'object') {
          const node = x as Record<string, unknown>;
          const fromText = node.text;
          if (typeof fromText === 'string') return [fromText];
          const fromName = node.name;
          if (typeof fromName === 'string') return [fromName];
        }
        return [];
      })
      .map((s) => s.trim())
      .filter((s): s is string => Boolean(s));
  }
  if (typeof v === 'string') {
    return v
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter((s): s is string => Boolean(s));
  }
  return [];
};

export const clampInt = (n: unknown): number | null => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
};

export const getDomain = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

const UNIT_ALIASES = new Map<string, string>([
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
  ['sprig', 'sprig'],
  ['sprigs', 'sprig'],
  ['strip', 'strip'],
  ['strips', 'strip'],
  ['stalk', 'stalk'],
  ['stalks', 'stalk'],
  ['sheet', 'sheet'],
  ['sheets', 'sheet'],
]);

const normalizeUnit = (u: string | null | undefined): string | null => {
  if (!u) return null;
  const key = u.toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES.get(key) || key;
};

const UNICODE_FRACTIONS = new Map<string, string>([
  ['½', '1/2'],
  ['⅓', '1/3'],
  ['⅔', '2/3'],
  ['¼', '1/4'],
  ['¾', '3/4'],
  ['⅕', '1/5'],
  ['⅖', '2/5'],
  ['⅗', '3/5'],
  ['⅘', '4/5'],
  ['⅙', '1/6'],
  ['⅚', '5/6'],
  ['⅛', '1/8'],
  ['⅜', '3/8'],
  ['⅝', '5/8'],
  ['⅞', '7/8'],
]);

const replaceUnicodeFractions = (str: string): string =>
  str.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (ch, offset, src) => {
    const replacement = UNICODE_FRACTIONS.get(ch) || ch;
    const prev = offset > 0 ? src[offset - 1] : '';
    const needsSpace = prev && /\d/.test(prev);
    const prefix = needsSpace && prev !== ' ' ? ' ' : '';
    return `${prefix}${replacement}`;
  });

const numberPattern = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d*\\.\\d+|\\d+)';

const rangeRegex = new RegExp(
  `^(${numberPattern})\\s*(?:-|–|—|to)\\s*(${numberPattern})`,
  'i',
);

const singleNumberRegex = new RegExp(`^(${numberPattern})`);

const parseNumericToken = (token: string | null | undefined): number | null => {
  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed.includes(' ')) {
    const [whole, frac] = trimmed.split(/\s+/, 2);
    const wholeNum = parseNumericToken(whole);
    const fracNum = parseNumericToken(frac);
    if (wholeNum != null && fracNum != null) return wholeNum + fracNum;
  }
  if (trimmed.includes('/')) {
    const [num, den] = trimmed.split('/');
    const n = parseFloat(num);
    const d = parseFloat(den);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
      return n / d;
    }
  }
  const parsed = parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const findCommaOutsideParens = (value: string): number => {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
};

const DURATION_REGEX_SOURCE = `(?:about\\s+|around\\s+|approximately\\s+|at\\s+least\\s+|up\\s+to\\s+|for\\s+|another\\s+|an\\s+additional\\s+|extra\\s+)?(${numberPattern})(?:\\s*(?:-|–|—|to)\\s*(${numberPattern}))?\\s*(hours?|hour|hrs?|hr|h|minutes?|minute|mins?|min|m)\\b`;

const convertDurationMatchToMinutes = (
  primary: number | null,
  secondary: number | null,
  unit: string,
): number | null => {
  if (primary == null || !Number.isFinite(primary)) return null;
  let amount = primary;
  if (secondary != null && Number.isFinite(secondary)) {
    amount = (primary + secondary) / 2;
  }
  const unitKey = unit.toLowerCase();
  if (unitKey.startsWith('h')) return amount * 60;
  if (unitKey.startsWith('m')) return amount;
  return null;
};

const collectDurationsFromText = (text: string): number[] => {
  const normalized = replaceUnicodeFractions(text).toLowerCase();
  const durationRe = new RegExp(DURATION_REGEX_SOURCE, 'gi');
  const durations: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = durationRe.exec(normalized))) {
    const primary = parseNumericToken(match[1]);
    const secondary = match[2] ? parseNumericToken(match[2]) : null;
    const unit = match[3] ?? '';
    const minutes = convertDurationMatchToMinutes(primary, secondary, unit);
    if (minutes != null && Number.isFinite(minutes)) durations.push(minutes);
  }
  return durations;
};

export function parseIngredientLine(line: string): Ingredient | null {
  const compact = line.trim().replace(/\s+/g, ' ');
  if (!compact) return null;

  const decoded = decode(compact);
  const original =
    typeof decoded === 'string' ? decoded : String(decoded ?? '').trim();
  if (!original) return null;

  const prepared = replaceUnicodeFractions(original).replace(/[−–—]/g, '-');

  let rest = prepared;
  let quantity: number | null = null;
  const noteParts: string[] = [];

  const rangeMatch = rest.match(rangeRegex);
  if (rangeMatch) {
    const minText = rangeMatch[1];
    const maxText = rangeMatch[2];
    const minVal = parseNumericToken(minText);
    const maxVal = parseNumericToken(maxText);
    if (minVal != null) {
      quantity = minVal;
    }
    if (
      maxVal != null &&
      minVal != null &&
      Number.isFinite(maxVal) &&
      Number.isFinite(minVal)
    ) {
      const orderedMin = Math.min(minVal, maxVal);
      const orderedMax = Math.max(minVal, maxVal);
      if (orderedMin !== orderedMax) {
        quantity = orderedMin;
        noteParts.push(`range ${minText} - ${maxText}`);
      }
    }
    rest = rest.slice(rangeMatch[0].length).trim();
  }

  if (quantity == null) {
    const qtyMatch = rest.match(singleNumberRegex);
    if (qtyMatch) {
      quantity = parseNumericToken(qtyMatch[1]);
      rest = rest.slice(qtyMatch[0].length).trim();
    }
  }

  rest = rest.trim();

  const leadingNotes: string[] = [];
  while (rest.startsWith('(')) {
    const leading = rest.match(/^\(([^()]+)\)\s*/);
    if (!leading) break;
    const inner = leading[1].trim();
    if (inner) leadingNotes.push(inner);
    rest = rest.slice(leading[0].length).trim();
  }
  if (leadingNotes.length) noteParts.push(...leadingNotes);

  let unit: string | null = null;
  let item: string | null = rest;

  if (rest) {
    const tokMatch = rest.match(/^([a-zA-Z\.]+)\b/);
    if (tokMatch) {
      const maybeUnitRaw = tokMatch[1];
      const maybeUnit = normalizeUnit(maybeUnitRaw);
      const canonicalKey = maybeUnitRaw.toLowerCase().replace(/\.$/, '');
      if (
        maybeUnit &&
        (UNIT_ALIASES.has(canonicalKey) ||
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
            'sprig',
            'strip',
            'stalk',
            'sheet',
          ].includes(maybeUnit))
      ) {
        unit = maybeUnit;
        item = rest.slice(tokMatch[0].length).trim();
      }
    }
  }
  if (item) item = item.trim();

  if (item) {
    while (/\([^()]*\)\s*$/.test(item)) {
      const match = item.match(/\(([^()]+)\)\s*$/);
      if (!match) break;
      const inner = match[1].trim();
      if (inner) noteParts.push(inner);
      const matchIndex =
        typeof match.index === 'number' ? match.index : item.length - match[0].length;
      item = item.slice(0, matchIndex).trim();
    }
  }

  if (item) {
    const commaIndex = findCommaOutsideParens(item);
    if (commaIndex !== -1) {
      const afterComma = item.slice(commaIndex + 1).trim();
      if (afterComma) noteParts.push(afterComma);
      item = item.slice(0, commaIndex).trim();
    }
  }

  if (item && /^of\s+/i.test(item)) item = item.replace(/^of\s+/i, '');

  if (item) {
    const starMatch = item.match(/\*+$/);
    if (starMatch) {
      item = item.slice(0, starMatch.index).trim();
    }
    item = item
      .replace(/^[\s\-–—.,]+/, '')
      .replace(/[\s(]+$/, '')
      .trim();
  }

  const note =
    noteParts
      .map((n) =>
        n
          .replace(/^[\s,;()-]+/, '')
          .replace(/\*+$/, '')
          .replace(/[\s)]+$/, '')
          .trim(),
      )
      .filter((n): n is string => Boolean(n))
      .join('; ') || null;

  return {
    original,
    quantity: quantity ?? null,
    unit: unit ?? null,
    item: item || null,
    note,
  };
}

export const inferCookMinutesFromSteps = (
  steps: Recipe['steps'],
): number | null => {
  let maxMinutes: number | null = null;
  for (const step of steps) {
    const durations = collectDurationsFromText(step.text);
    for (const minutes of durations) {
      if (minutes == null || !Number.isFinite(minutes)) continue;
      if (maxMinutes == null || minutes > maxMinutes) {
        maxMinutes = minutes;
      }
    }
  }
  return maxMinutes;
};

export const isShoutyHeading = (s: string | null | undefined): s is string => {
  if (!s) return false;
  const t = s.trim();
  const words = t.split(/\s+/);
  if (words.length <= 4) {
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters && letters === letters.toUpperCase()) return true;
  }
  return /^for the\b/i.test(t) || /^serv(e|ing)s\b/i.test(t);
};

type StepLike = string | { text?: string | null };

export function normalizeSteps(
  arr: ReadonlyArray<StepLike> | null | undefined,
): Recipe['steps'] {
  const steps = (arr ?? [])
    .map((s) => (typeof s === 'string' ? s : s?.text ?? ''))
    .map((s) => {
      const decoded = decode(s.trim());
      return typeof decoded === 'string' ? decoded : String(decoded ?? '');
    })
    .filter((s): s is string => Boolean(s))
    .filter((s) => !isShoutyHeading(s))
    .map((text, i) => ({ n: i + 1, text }));
  return steps;
}
