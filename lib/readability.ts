import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export const extractReadableContent = (
  html: string,
  url: string,
): string | null => {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return null;
    return article.content;
  } catch (err) {
    const message =
      typeof err === 'object' && err && 'message' in err
        ? String((err as { message?: unknown }).message)
        : String(err);
    console.warn('[readability] extraction failed', message);
    return null;
  }
};
