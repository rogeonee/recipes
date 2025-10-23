import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export const extractReadableContent = (html, url) => {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return null;
    return article.content;
  } catch (err) {
    console.warn('[readability] extraction failed', err?.message || err);
    return null;
  }
};
