"""Optional AI enrichment via an OpenAI-compatible ``/chat/completions`` API.

Design notes
------------
* Enrichment is strictly best-effort: any failure raises
  :class:`AIEnrichmentError` and the caller (``services.ingest``) only marks
  ``ai_status = failed``. The scraped article is never lost.
* ``User-Agent`` is always set explicitly (``settings.llm_user_agent``, default
  ``jiancang/0.1``) because some gateways (Cloudflare) reject httpx's default
  UA with ``1010`` before the request ever reaches the model.
* Models love markdown fences, so JSON is extracted defensively.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import Settings
from app.models import ArticleChatContext, ChatTurnInput

_MAX_CONTENT_CHARS = 6000

MAX_CHAT_CONTENT_CHARS = 12000
MAX_CHAT_HISTORY_MESSAGES = 20

_SYSTEM_PROMPT = (
    "你是一名中文「内容整理助手」，负责把剪藏的网页/公众号/推文正文压缩成可复习的卡片。\n"
    "只输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块之外的文字。\n"
    "JSON 结构：\n"
    '{"summary": "一句话中文摘要（<=60字）", '
    '"key_points": ["要点1", "要点2", "要点3"], '
    '"tags": ["标签1", "标签2"]}\n'
    "要求：\n"
    "1. summary 必须是 <=60 字的中文一句话，直接说结论，不要写“本文介绍了”。\n"
    "2. key_points 3~5 条，每条 <=40 字，具体、可验证，不要空话。\n"
    "3. tags 2~4 个短标签（每个 2~6 字），优先复用用户已有标签中语义一致的。\n"
    "4. 不要编造正文里没有的事实；正文信息不足时给出更泛化的摘要与要点。"
)

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
_CODE_FENCE_RE = re.compile(r"^```(?:json|JSON)?\s*|\s*```$")

_CHAT_SYSTEM_PROMPT = (
    "你是一名「文章精读与讨论助手」，帮助用户深入理解并讨论他剪藏的文章。\n"
    "回答原则：\n"
    "1. 优先严格基于下面提供的文章标题、摘要、要点、正文和个人笔记作答，"
    "引用原文细节时不要改写事实。\n"
    "2. 明确区分「文章中提到的信息」与「补充背景/推论」："
    "凡是正文没有出现的内容，绝不声称是原文所述，需要时明确标注为补充或推测。\n"
    "3. 正文不足时直接说明，并结合标题/摘要/笔记给出谨慎回答，不要编造细节。\n"
    "4. 回答简洁、有条理，必要时用短列表；默认使用中文，"
    "若用户用其他语言提问则跟随用户语言。"
)


class AIEnrichmentError(RuntimeError):
    """Raised when the LLM call or its JSON payload cannot be used."""


class AIChatError(AIEnrichmentError):
    """Raised when an article chat call cannot produce a usable reply."""


@dataclass(slots=True)
class AIEnrichment:
    summary: str = ""
    key_points: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


def build_messages(
    title: str, content_text: str, existing_tags: list[str]
) -> list[dict[str, str]]:
    body = (content_text or "").strip()
    if len(body) > _MAX_CONTENT_CHARS:
        body = body[:_MAX_CONTENT_CHARS] + "\n...(正文已截断)"
    tags_hint = "、".join(existing_tags) if existing_tags else "（无）"
    user_prompt = (
        f"标题：{title.strip() or '（无标题）'}\n"
        f"用户已有标签：{tags_hint}\n"
        "请阅读下面的正文并输出 JSON：\n"
        "----正文开始----\n"
        f"{body or '（正文为空）'}\n"
        "----正文结束----"
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]


def strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    stripped = _CODE_FENCE_RE.sub("", stripped)
    return stripped.strip()


def extract_json_object(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a possibly chatty model reply."""
    if not text or not text.strip():
        raise AIEnrichmentError("empty model response")
    candidate = strip_code_fence(text)
    try:
        parsed = json.loads(candidate)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed
    match = _JSON_OBJECT_RE.search(candidate)
    if match is None:
        raise AIEnrichmentError("no JSON object in model response")
    try:
        parsed = json.loads(match.group(0))
    except ValueError as exc:
        raise AIEnrichmentError(f"invalid JSON in model response: {exc}") from exc
    if not isinstance(parsed, dict):
        raise AIEnrichmentError("model response JSON is not an object")
    return parsed


def _coerce_list(value: Any, limit: int) -> list[str]:
    if isinstance(value, str):
        pieces: list[Any] = re.split(r"[,，;；\n]+", value)
    elif isinstance(value, (list, tuple, set)):
        pieces = list(value)
    else:
        return []
    items: list[str] = []
    for piece in pieces:
        text = " ".join(str(piece).split())
        if not text:
            continue
        if text not in items:
            items.append(text)
        if len(items) >= limit:
            break
    return items


def _coerce_summary(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    summary = " ".join(value.split())
    if len(summary) > 120:
        summary = summary[:119] + "…"
    return summary


def parse_enrichment(payload: dict[str, Any]) -> AIEnrichment:
    summary = _coerce_summary(payload.get("summary") or payload.get("abstract") or "")
    key_points = _coerce_list(payload.get("key_points") or payload.get("points"), 5)
    tags = _coerce_list(payload.get("tags"), 4)
    if not summary and not key_points and not tags:
        raise AIEnrichmentError("model response contained no usable fields")
    return AIEnrichment(summary=summary, key_points=key_points, tags=tags)


def _message_content(data: dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise AIEnrichmentError("model response has no choices")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    if not isinstance(message, dict):
        message = first if isinstance(first, dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    raise AIEnrichmentError("model response message has no text content")


async def enrich_clip(
    title: str,
    content_text: str,
    existing_tags: list[str],
    settings: Settings,
    client: httpx.AsyncClient | None = None,
) -> AIEnrichment | None:
    """Ask the LLM for a summary / key points / tags.

    Returns ``None`` when AI is disabled. Raises :class:`AIEnrichmentError` when
    the call or the payload fails.
    """
    if not settings.ai_enabled:
        return None
    if not (content_text or "").strip() and not (title or "").strip():
        raise AIEnrichmentError("nothing to enrich")

    base_url = settings.llm_base_url.strip().rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {settings.llm_api_key.strip()}",
        "User-Agent": settings.llm_user_agent or "jiancang/0.1",
    }
    payload = {
        "model": settings.llm_model,
        "messages": build_messages(title, content_text, list(existing_tags)),
        "temperature": 0.2,
        "stream": False,
    }

    owns_client = client is None
    http_client = client or httpx.AsyncClient(
        timeout=httpx.Timeout(settings.llm_timeout_seconds),
        follow_redirects=True,
    )
    try:
        response = await http_client.post(
            endpoint, json=payload, headers=headers
        )
        if response.status_code >= 400:
            raise AIEnrichmentError(
                f"llm http {response.status_code}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise AIEnrichmentError("llm returned non-JSON body") from exc
        if not isinstance(data, dict):
            raise AIEnrichmentError("llm returned unexpected payload")
        return parse_enrichment(extract_json_object(_message_content(data)))
    except AIEnrichmentError:
        raise
    except httpx.HTTPError as exc:
        raise AIEnrichmentError(f"llm request failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - network/proxy weirdness
        raise AIEnrichmentError(f"llm enrichment failed: {exc}") from exc
    finally:
        if owns_client:
            await http_client.aclose()


def _article_prompt(article: ArticleChatContext) -> str:
    """Format the article context embedded in the chat system message."""
    body = (article.content_text or "").strip()
    if len(body) > MAX_CHAT_CONTENT_CHARS:
        body = body[:MAX_CHAT_CONTENT_CHARS] + "\n...(正文已截断)"
    if not body:
        body = "（正文暂缺，请结合标题/摘要/笔记回答并向用户说明正文不足）"
    points = [str(item).strip() for item in article.key_points if str(item).strip()]
    lines = [
        "以下是用户正在精读的文章资料：",
        f"标题：{article.title.strip() or '（无标题）'}",
        f"作者：{article.author.strip() or '（未知）'}",
        f"来源平台：{article.platform}",
        f"原文链接：{article.url.strip() or '（无）'}",
        f"摘要：{article.summary.strip() or '（无）'}",
        "要点：",
        *([f"- {point}" for point in points] or ["- （无）"]),
        f"个人笔记：{article.user_note.strip() or '（无）'}",
        "正文：",
        body,
    ]
    return "\n".join(lines)


def build_chat_messages(
    article: ArticleChatContext, history: Sequence[ChatTurnInput]
) -> list[dict[str, str]]:
    """Build the OpenAI-style message list for an article discussion turn."""
    turns = [turn for turn in history if (turn.content or "").strip()]
    kept = turns[-MAX_CHAT_HISTORY_MESSAGES:]
    system = _CHAT_SYSTEM_PROMPT + "\n\n" + _article_prompt(article)
    return [
        {"role": "system", "content": system},
        *[
            {"role": str(turn.role), "content": turn.content.strip()}
            for turn in kept
        ],
    ]


async def chat_with_article(
    article: ArticleChatContext,
    history: Sequence[ChatTurnInput],
    settings: Settings,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, str]:
    """Ask the LLM about ``article``; returns ``(reply, model_name)``.

    Raises :class:`AIChatError` when AI is disabled, the history has no user
    turn, or the upstream call/reply is unusable.
    """
    if not settings.ai_enabled:
        raise AIChatError("AI is not enabled")

    messages = build_chat_messages(article, history)
    if not any(item["role"] == "user" for item in messages):
        raise AIChatError("empty chat history")

    base_url = settings.llm_base_url.strip().rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {settings.llm_api_key.strip()}",
        "User-Agent": settings.llm_user_agent or "jiancang/0.1",
    }
    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.5,
        "stream": False,
    }

    timeout = max(float(settings.llm_timeout_seconds), 60.0)
    owns_client = client is None
    http_client = client or httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
    )
    try:
        response = await http_client.post(endpoint, json=payload, headers=headers)
        if response.status_code >= 400:
            raise AIChatError(
                f"llm http {response.status_code}: {response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise AIChatError("llm returned non-JSON body") from exc
        if not isinstance(data, dict):
            raise AIChatError("llm returned unexpected payload")
        try:
            reply = _message_content(data).strip()
        except AIEnrichmentError as exc:
            raise AIChatError(str(exc)) from exc
        if not reply:
            raise AIChatError("empty model reply")
        return reply, str(data.get("model") or settings.llm_model)
    except AIChatError:
        raise
    except httpx.HTTPError as exc:
        raise AIChatError(f"llm request failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - network/proxy weirdness
        raise AIChatError(f"llm chat failed: {exc}") from exc
    finally:
        if owns_client:
            await http_client.aclose()


__all__ = [
    "AIChatError",
    "AIEnrichment",
    "AIEnrichmentError",
    "MAX_CHAT_CONTENT_CHARS",
    "MAX_CHAT_HISTORY_MESSAGES",
    "build_chat_messages",
    "build_messages",
    "chat_with_article",
    "enrich_clip",
    "extract_json_object",
    "parse_enrichment",
    "strip_code_fence",
]
