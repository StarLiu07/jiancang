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
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import Settings

_MAX_CONTENT_CHARS = 6000

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


class AIEnrichmentError(RuntimeError):
    """Raised when the LLM call or its JSON payload cannot be used."""


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


__all__ = [
    "AIEnrichment",
    "AIEnrichmentError",
    "build_messages",
    "enrich_clip",
    "extract_json_object",
    "parse_enrichment",
    "strip_code_fence",
]
