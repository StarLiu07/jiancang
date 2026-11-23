"""Optional bearer-token protection for the ``/api/*`` surface.

Auth is disabled (allow everything) when ``settings.api_token`` is empty, which
keeps local development frictionless. When a token is configured every
``/api/*`` request must present it either as ``Authorization: Bearer <token>``
or ``X-API-Key: <token>``. ``/api/media/{id}`` additionally accepts
``?token=<token>`` so ``<img src="...">`` tags can load images without custom
headers.
"""

from __future__ import annotations

import hmac
from typing import Any

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.config import Settings

# Paths that never require a token (health probe, docs, static UI assets).
_OPEN_PREFIXES: tuple[str, ...] = (
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/favicon.ico",
)

_MEDIA_PREFIX = "/api/media/"


def _extract_token(request: Request, allow_query: bool) -> str:
    header = request.headers.get("authorization") or ""
    if header:
        scheme, _, value = header.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
        if scheme.lower() == "token" and value.strip():
            return value.strip()
    api_key = request.headers.get("x-api-key") or ""
    if api_key.strip():
        return api_key.strip()
    if allow_query:
        query_token = request.query_params.get("token") or ""
        if query_token.strip():
            return query_token.strip()
    return ""


def _matches(candidate: str, expected: str) -> bool:
    if not candidate:
        return False
    try:
        return hmac.compare_digest(
            candidate.encode("utf-8"), expected.encode("utf-8")
        )
    except (TypeError, ValueError):  # pragma: no cover - non-ascii edge case
        return False


def _requires_auth(path: str) -> bool:
    if not path.startswith("/api/"):
        return False
    return not any(path.startswith(prefix) for prefix in _OPEN_PREFIXES)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated ``/api/*`` requests with ``401``."""

    def __init__(self, app: Any, token: str) -> None:
        super().__init__(app)
        self.token = token

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not self.token:
            return await call_next(request)

        path = request.url.path
        if not _requires_auth(path):
            return await call_next(request)

        allow_query = path.startswith(_MEDIA_PREFIX)
        candidate = _extract_token(request, allow_query=allow_query)
        if not _matches(candidate, self.token):
            return JSONResponse(
                {"detail": "Unauthorized"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)


def install_auth(app: FastAPI, settings: Settings) -> None:
    """Attach the token middleware only when a token is configured."""
    token = (settings.api_token or "").strip()
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)


def auth_enabled(settings: Settings) -> bool:
    return bool((settings.api_token or "").strip())


__all__ = ["TokenAuthMiddleware", "auth_enabled", "install_auth"]
