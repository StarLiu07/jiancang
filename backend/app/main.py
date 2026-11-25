"""FastAPI application factory for 剪藏 (Jiancang)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import auth_enabled, install_auth
from app.config import Settings, get_settings
from app.db import Database
from app.models import HealthResponse
from app.routers import clips, review, sync, tags

logger = logging.getLogger(__name__)


def _cors_origins(raw: str) -> list[str]:
    origins = [item.strip() for item in (raw or "").split(",") if item.strip()]
    return origins or ["*"]


def _init_db(resolved: Settings) -> Database:
    resolved.data_dir.mkdir(parents=True, exist_ok=True)
    resolved.media_dir.mkdir(parents=True, exist_ok=True)
    return Database(resolved.db_path)


def create_app(settings: Settings | None = None, *, eager_db: bool = True) -> FastAPI:
    """Build the application; ``settings`` may be injected for tests."""
    resolved = settings or get_settings()
    database: Database | None = _init_db(resolved) if eager_db else None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if getattr(app.state, "db", None) is None:
            app.state.db = _init_db(resolved)
        try:
            yield
        finally:
            db_instance = getattr(app.state, "db", None)
            if db_instance is not None:
                db_instance.close()

    app = FastAPI(
        title=resolved.app_name,
        version="0.1.0",
        summary="Self-hosted web clipper with spaced review",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.db = database

    # Auth middleware first so CORS stays outermost (401s still get CORS headers).
    install_auth(app, resolved)
    origins = _cors_origins(resolved.cors_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=origins != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(clips.router)
    app.include_router(clips.media_router)
    app.include_router(clips.ai_router)
    app.include_router(clips.extract_router)
    app.include_router(review.router)
    app.include_router(sync.router)
    app.include_router(tags.router)

    @app.get("/health", response_model=HealthResponse, tags=["meta"])
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            app=resolved.app_name,
            ai_enabled=resolved.ai_enabled,
            auth_enabled=auth_enabled(resolved),
        )

    @app.get("/", include_in_schema=False)
    def root() -> dict[str, str]:
        return {
            "app": resolved.app_name,
            "health": "/health",
            "docs": "/docs",
        }

    return app


app = create_app(eager_db=False)


__all__ = ["app", "create_app"]
