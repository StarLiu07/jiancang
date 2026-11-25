/**
 * Unified extractor entry point.
 *
 * Dispatches by platform (auto-detected from the URL) and guarantees that no
 * exception ever escapes: any unexpected failure becomes a `partial` clip so
 * the caller can still persist the user's raw input and retry later.
 */

import type { Platform } from '../../types';
import type { ExtractedContent } from './base';
import { detectPlatform } from '../urlUtils';
import type { FetchedPage } from './generic';
import {
  degradedContent,
  errorLabel,
  fallbackTitle,
  fetchHtml,
  parseGenericHtml,
} from './generic';
import { extractWeChat, parseWeChatHtml } from './wechat';
import { extractX } from './x';
import { extractXhs } from './xhs';

export type { ExtractedContent } from './base';
export { markdownToText } from './base';
export { parseGenericHtml, extractGeneric, htmlToMarkdown, htmlToText } from './generic';
export { parseWeChatHtml, extractWeChat, WECHAT_REFERER } from './wechat';
export { parseStatusUrl, parseFxTwitterPayload, extractX, FX_API_URL, X_REFERER } from './x';
export { extractNoteId, unwrapXhsRedirect, parseXhsHtml, extractXhs, XHS_HEADERS, XHS_REFERER } from './xhs';

export type ExtractorPlatform = Platform;

/**
 * Fetch an unknown link and route a second time once the redirect reveals the
 * real platform (t.co -> x.com, /go?url=... -> xiaohongshu, wx short links...).
 */
async function extractWeb(url: string, rawInput: string): Promise<ExtractedContent> {
  let page: FetchedPage;
  try {
    page = await fetchHtml(url);
  } catch (error) {
    return degradedContent({
      platform: 'web',
      url,
      rawInput,
      errorMessage: errorLabel(error),
    });
  }

  const finalUrl = (page.finalUrl || url).trim() || url;
  const redirected = detectPlatform(finalUrl);

  if (redirected === 'x') return extractX(finalUrl, rawInput);
  if (redirected === 'xiaohongshu') return extractXhs(finalUrl, rawInput);
  if (redirected === 'wechat') return parseWeChatHtml(page.html, finalUrl, rawInput);

  return parseGenericHtml(page.html, finalUrl, rawInput);
}

/**
 * Fetch and parse `url` with the extractor matching its platform.
 *
 * `rawInput` should be the original share caption so degraded clips still keep
 * whatever text the user actually shared.
 */
export async function extractContent(url: string, rawInput = ''): Promise<ExtractedContent> {
  const platform = detectPlatform(url);

  try {
    switch (platform) {
      case 'wechat':
        return await extractWeChat(url, rawInput);
      case 'x':
        return await extractX(url, rawInput);
      case 'xiaohongshu':
        return await extractXhs(url, rawInput);
      case 'web':
      default:
        return await extractWeb(url, rawInput);
    }
  } catch (error) {
    // Last-resort guard: an extractor bug must never lose the user's clip.
    return degradedContent({
      platform,
      url,
      rawInput,
      errorMessage: errorLabel(error),
      fallbackToUrl: true,
    });
  }
}

export { fallbackTitle };
