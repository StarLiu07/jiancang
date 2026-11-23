"""FastAPI routers plus the shared dependencies they use.

Importing this package must stay side-effect free (only helper definitions) so
``app.routers.clips`` can import ``get_db`` without a circular import.
"""

from __future__ import annotations

from fastapi import Request

from app.config import Settings
from app.db import Database


def get_db(request: Request) -> Database:
    """Return the process-wide :class:`Database` stored on ``app.state``."""
    db = getattr(request.app.state, "db", None)
    if db is None:
        settings: Settings = request.app.state.settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        db = Database(settings.db_path)
        request.app.state.db = db
    return db


def get_settings(request: Request) -> Settings:
    """Return the :class:`Settings` instance the app was created with."""
    return request.app.state.settings


__all__ = ["get_db", "get_settings"]
