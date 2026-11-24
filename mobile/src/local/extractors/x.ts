/**
 * X / Twitter status extractor backed by the public fxtwitter API.
 *
 * Ported from `backend/app/services/extractors/x.py`. Failures always degrade
 * to a `partial` clip instead of throwing.
 */

import type { ExtractedContent } from './base';
import {
  BROWSER_HEADERS,
  cleanText,
  composeMarkdown,
  degradedContent,
  errorLabel,
  fallbackTitle,
  fetchJson,
  firstLine,
  isRecord,
  tidyMarkdown,
} from './generic';
import { asArray } from './generic';
import { splitUrlParts } from '../urlUtils';

export const FX_API_URL = 'https://api.fxtwitter.com/{screen_name}/status/{status_id}';
export const X_REFERER = 'https://x.com/';

const STATUS_SEGMENTS = new Set(['status', 'statuses']);

/**
 * Return `[screen_name, status_id]` extracted from any Twitter/X URL flavour.
 * Mirrors the Python tuple return value.
 */
export function parseStatusUrl(url: string): [string | null, string | null] {
  const parts = splitUrlParts(url);
  const segments = parts.path.split('/').filter(Boolean);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!STATUS_SEGMENTS.has(segment.toLowerCase())) continue;
    if (index + 1 >= segments.length || !/^\d+$/.test(segments[index + 1])) continue;

    let screenName = index >= 1 ? segments[index - 1] : 'i';
    if (screenName.toLowerCase() === 'web' && index >= 2) {
      screenName = segments[index - 2];
    }
    if (['i', 'web', 'intent'].includes(screenName.toLowerCase())) {
      screenName = 'i';
    }
    return [screenName, segments[index + 1]];
  }
  return [null, null];
}

function mediaImages(media: unknown, includeAll = true): string[] {
  if (!isRecord(media)) return [];
  const urls: string[] = [];
  const add = (value: unknown): void => {
    const url = cleanText(value);
    if ((url.startsWith('http://') || url.startsWith('https://')) && !urls.includes(url)) {
      urls.push(url);
    }
  };

  for (const photo of asArray(media.photos)) {
    if (isRecord(photo)) add(photo.url || photo.thumbnail_url);
  }
  for (const video of asArray(media.videos)) {
    if (isRecord(video)) add(video.thumbnail_url || video.url);
  }
  if (includeAll) {
    for (const item of asArray(media.all)) {
      if (!isRecord(item)) continue;
      if (item.type === 'photo') {
        add(item.url || item.thumbnail_url);
      } else {
        add(item.thumbnail_url);
      }
    }
  }
  return urls;
}

/** Return `[heading, body, imageUrls]` for an X Article payload. */
function articleSection(article: unknown): [string, string, string[]] {
  if (!isRecord(article)) return ['', '', []];

  const title = cleanText(article.title);
  const blocks: string[] = [];
  const content = article.content;
  if (isRecord(content)) {
    for (const block of asArray(content.blocks)) {
      if (isRecord(block)) {
        const text = cleanText(block.text);
        if (text) blocks.push(text);
      }
    }
  } else if (typeof content === 'string') {
    const text = cleanText(content);
    if (text) blocks.push(text);
  }

  const body = blocks.join('\n\n') || cleanText(article.preview_text);
  const images: string[] = [];
  const cover = article.cover_media;
  if (isRecord(cover)) images.push(...mediaImages({ photos: [cover] }));
  images.push(...mediaImages(article.media));

  const heading = title ? `## ${title}` : '## X Article';
  return [heading, body, images];
}

function buildFromTweet(url: string, tweet: Record<string, unknown>, rawInput: string): ExtractedContent {
  const text = String(tweet.text ?? '').replace(/\r\n/g, '\n').trim();
  const authorObj = isRecord(tweet.author) ? tweet.author : {};
  const authorName = cleanText(authorObj.name);
  const screenName = cleanText(authorObj.screen_name);
  let author: string;
  if (authorName && screenName && authorName.toLowerCase() !== screenName.toLowerCase()) {
    author = `${authorName} (@${screenName})`;
  } else {
    author = authorName || (screenName ? `@${screenName}` : '');
  }

  const title = firstLine(text) || (screenName ? `@${screenName} 的推文` : fallbackTitle(rawInput, url));
  const publishedAt = cleanText(tweet.created_at) || null;

  const imageUrls = mediaImages(tweet.media);

  const sections: string[] = [];
  if (text) sections.push(text);

  const quote = tweet.quote;
  if (isRecord(quote)) {
    const quoteAuthor = isRecord(quote.author) ? cleanText(quote.author.screen_name) : '';
    const quoteText = String(quote.text ?? '').trim();
    const quoteLines: string[] = [quoteAuthor ? `> 引用 @${quoteAuthor}:` : '> 引用:'];
    for (const line of quoteText.split('\n')) {
      quoteLines.push(`> ${line}`.replace(/\s+$/, ''));
    }
    sections.push(quoteLines.join('\n'));
    for (const quoteImage of mediaImages(quote.media)) {
      if (!imageUrls.includes(quoteImage)) imageUrls.push(quoteImage);
    }
  }

  const [heading, articleBody, articleImages] = articleSection(tweet.article);
  if (articleBody || articleImages.length) {
    sections.push(heading);
    if (articleBody) sections.push(articleBody);
    for (const articleImage of articleImages) {
      if (!imageUrls.includes(articleImage)) imageUrls.push(articleImage);
    }
  }

  const contentMarkdown = tidyMarkdown(
    composeMarkdown({ body: sections.join('\n\n'), imageUrls }),
  );
  const contentText = tidyMarkdown(text);

  return {
    platform: 'x',
    url: cleanText(tweet.url) || url,
    title,
    author,
    published_at: publishedAt,
    content_markdown: contentMarkdown,
    content_text: contentText,
    image_urls: imageUrls,
    partial: !(text || imageUrls.length || articleBody),
    error_message: null,
    referer: X_REFERER,
  };
}

function degradedX(url: string, rawInput: string, message: string): ExtractedContent {
  return degradedContent({
    platform: 'x',
    url,
    rawInput,
    errorMessage: message,
    referer: X_REFERER,
    fallbackToUrl: true,
  });
}

/** Pure parser for a fxtwitter payload (and unit tests). */
export function parseFxTwitterPayload(payload: unknown, url: string, rawInput = ''): ExtractedContent {
  if (!isRecord(payload)) {
    return degradedX(url, rawInput, 'fxtwitter 返回了非预期格式');
  }
  const code = payload.code;
  if (code !== null && code !== undefined && code !== 200) {
    const message = payload.message || `fxtwitter code=${String(code)}`;
    return degradedX(url, rawInput, String(message));
  }
  const tweet = payload.tweet;
  if (!isRecord(tweet)) {
    return degradedX(url, rawInput, 'fxtwitter 未返回推文内容');
  }
  return buildFromTweet(url, tweet, rawInput);
}

/** Fetch a status via fxtwitter; never throws. */
export async function extractX(url: string, rawInput = ''): Promise<ExtractedContent> {
  const [screenName, statusId] = parseStatusUrl(url);
  if (!statusId) {
    return degradedX(url, rawInput, '无法从链接中解析推文 ID');
  }

  const apiUrl = FX_API_URL.replace('{screen_name}', encodeURIComponent(screenName || 'i')).replace(
    '{status_id}',
    encodeURIComponent(statusId),
  );
  try {
    const payload = await fetchJson(apiUrl, BROWSER_HEADERS);
    return parseFxTwitterPayload(payload, url, rawInput);
  } catch (error) {
    return degradedX(url, rawInput, errorLabel(error));
  }
}
