/**
 * Shared extractor contracts and Markdown helpers.
 *
 * The `ExtractedContent` shape mirrors `backend/app/services/extractors/base.py`
 * so local clips can be synced to the FastAPI backend without transformation.
 */

import type { Platform } from '../../types';

export interface ExtractedContent {
  platform: Platform;
  url: string;
  title: string;
  author: string;
  published_at: string | null;
  content_markdown: string;
  content_text: string;
  image_urls: string[];
  partial: boolean;
  error_message: string | null;
  referer: string | null;
}

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const MD_HTML_RE = /<[^>]+>/g;
const MD_MARKS_RE = /[*_`~]+/g;
const MD_LEAD_RE = /^\s*(#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+)/gm;

/**
 * Very light Markdown -> plain text conversion, used for FTS and AI input.
 * Ported from `backend/app/services/ingest.py`.
 */
export function markdownToText(markdown: string): string {
  if (!markdown) return '';
  let text = markdown.replace(MD_IMAGE_RE, '');
  text = text.replace(MD_LINK_RE, '$1');
  text = text.replace(MD_HTML_RE, ' ');
  text = text.replace(MD_MARKS_RE, '');
  text = text.replace(MD_LEAD_RE, '');
  const lines = text.split('\n').map((line) => line.split(/\s+/).filter(Boolean).join(' '));
  return lines.filter((line) => line).join('\n').trim();
}
