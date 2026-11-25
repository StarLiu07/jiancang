/**
 * WeChat Official Account (`mp.weixin.qq.com`) article extractor.
 *
 * Ported from `backend/app/services/extractors/wechat.py`. WeChat lazy-loads
 * every body image through `data-src`, so images are rewritten before the
 * HTML -> Markdown conversion.
 */

import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';

import type { ExtractedContent } from './base';
import {
  BROWSER_HEADERS,
  cleanImageUrl,
  cleanText,
  collectImages,
  composeMarkdown,
  degradedContent,
  dropNoise,
  errorLabel,
  fallbackTitle,
  fetchHtml,
  firstLine,
  htmlToMarkdown,
  htmlToText,
  metaContent,
  ogImages,
  tidyMarkdown,
} from './generic';

export const WECHAT_REFERER = 'https://mp.weixin.qq.com/';

/** Text WeChat only shows on its "environment anomaly" verification wall. */
const VERIFY_MARKERS = ['环境异常', '完成验证后即可继续访问', '去验证'];
const VERIFY_MESSAGE = '触发微信访问验证，无法直接抓取正文';

/** True when the page is the anti-bot wall instead of an article. */
function isWeChatVerificationPage(root: HTMLElement): boolean {
  const text = htmlToText(root);
  return VERIFY_MARKERS.some((marker) => text.includes(marker));
}

/** Pure HTML parser used by the WeChat extractor (and unit tests). */
export function parseWeChatHtml(html: string, url: string, rawInput = ''): ExtractedContent {
  const root = parse(html);

  const explicitBody = root.querySelector('#js_content') || root.querySelector('.rich_media_content');

  const titleNode = root.querySelector('#activity-name') || root.querySelector('.rich_media_title');
  let title = cleanText(titleNode ? titleNode.text : '');
  title = title || cleanText(metaContent(root, 'og:title'));
  title = title || cleanText(metaContent(root, 'twitter:title'));
  if (!title) {
    const docTitle = root.querySelector('title');
    title = cleanText(docTitle ? docTitle.text : '');
  }
  title = title || fallbackTitle(rawInput, url);

  const authorNode = root.querySelector('#js_name') || root.querySelector('.rich_media_meta_nickname');
  let author = cleanText(authorNode ? authorNode.text : '');
  author = author || cleanText(metaContent(root, 'author'));
  author = author || cleanText(metaContent(root, 'og:article:author'));

  const publishedNode = root.querySelector('#publish_time') || root.querySelector('.rich_media_meta_text');
  const publishedAt =
    cleanText(metaContent(root, 'article:published_time')) ||
    cleanText(metaContent(root, 'og:release_date')) ||
    cleanText(publishedNode ? publishedNode.text : '') ||
    null;

  const contentNode =
    explicitBody ||
    root.querySelector('article') ||
    root.querySelector('body') ||
    root;

  // A verification wall has no #js_content; without this guard the page's
  // "环境异常 / 去验证" copy was happily stored as a `ready` article.
  if (!explicitBody && isWeChatVerificationPage(root)) {
    const caption = (rawInput || '').trim();
    return {
      platform: 'wechat',
      url,
      title,
      author,
      published_at: publishedAt,
      content_markdown: caption ? `${caption}\n` : '',
      content_text: caption || title,
      image_urls: [],
      partial: true,
      error_message: VERIFY_MESSAGE,
      referer: WECHAT_REFERER,
    };
  }

  dropNoise(contentNode);

  const contentImages = collectImages(contentNode, url);

  const imageUrls: string[] = [];
  for (const imageUrl of contentImages) {
    if (!imageUrls.includes(imageUrl)) imageUrls.push(imageUrl);
  }
  const covers: string[] = [];
  for (const raw of ogImages(root)) {
    const cover = cleanImageUrl(raw, url);
    if (cover && !imageUrls.includes(cover)) {
      imageUrls.push(cover);
      covers.push(cover);
    }
  }

  const bodyMarkdown = htmlToMarkdown(contentNode);
  let contentMarkdown = tidyMarkdown(bodyMarkdown);
  if (!contentMarkdown) {
    contentMarkdown = composeMarkdown({
      title,
      metaLine: author,
      body: cleanText(metaContent(root, 'og:description')),
      imageUrls,
    });
  } else {
    // Keep the cover image even when it is not part of the article body.
    for (const cover of covers) {
      if (!contentMarkdown.includes(cover)) contentMarkdown = `${contentMarkdown}\n\n![](${cover})`;
    }
  }

  let contentText = htmlToText(contentNode);
  if (!contentText) {
    contentText = cleanText(metaContent(root, 'og:description')) || title;
  }

  return {
    platform: 'wechat',
    url,
    title: firstLine(title, 200) || title,
    author,
    published_at: publishedAt,
    content_markdown: contentMarkdown,
    content_text: contentText,
    image_urls: imageUrls,
    partial: !bodyMarkdown,
    error_message: bodyMarkdown ? null : '找不到正文内容（#js_content）',
    referer: WECHAT_REFERER,
  };
}

/** Fetch and parse a WeChat article; never throws. */
export async function extractWeChat(url: string, rawInput = ''): Promise<ExtractedContent> {
  try {
    const page = await fetchHtml(url, BROWSER_HEADERS);
    return parseWeChatHtml(page.html, url, rawInput);
  } catch (error) {
    return degradedContent({
      platform: 'wechat',
      url,
      rawInput,
      errorMessage: errorLabel(error),
      referer: WECHAT_REFERER,
    });
  }
}
