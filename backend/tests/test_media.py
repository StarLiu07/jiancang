from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path

import httpx

from app.services import media

Handler = Callable[[httpx.Request], httpx.Response]

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 48
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 48
GIF = b"GIF89a" + b"\x00" * 24
WEBP = b"RIFF" + (24).to_bytes(4, "little") + b"WEBP" + b"VP8 " + b"\x00" * 12


def make_client(handler: Handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [path for path in root.rglob("*") if path.is_file()]


async def test_download_stores_images_with_magic_sniffing(tmp_path: Path) -> None:
    media_dir = tmp_path / "media"
    payloads: dict[str, tuple[bytes, str]] = {
        "https://cdn.example.com/a.png": (PNG, "image/png"),
        # Wrong / missing content-type: the WEBP magic number must win.
        "https://cdn.example.com/b.webp": (WEBP, "application/octet-stream"),
        "https://cdn.example.com/c.jpg": (JPEG, "text/plain"),
        "https://cdn.example.com/d.gif": (GIF, "image/gif"),
    }
    seen_headers: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        data, content_type = payloads[str(request.url)]
        seen_headers.append(dict(request.headers))
        return httpx.Response(200, content=data, headers={"content-type": content_type})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            list(payloads),
            media_dir,
            referer="https://mp.weixin.qq.com/",
            client=client,
        )

    assert [item.mime_type for item in stored] == [
        "image/png",
        "image/webp",
        "image/jpeg",
        "image/gif",
    ]
    assert [item.sort_order for item in stored] == [0, 1, 2, 3]

    for item in stored:
        data, _ = payloads[item.original_url]
        sha = hashlib.sha256(data).hexdigest()
        assert item.id == sha
        assert item.sha256 == sha
        assert item.size_bytes == len(data)
        assert item.local_path.startswith(f"{sha[:2]}/")
        assert "\\" not in item.local_path
        assert (media_dir / item.local_path).read_bytes() == data

    assert seen_headers[0]["referer"] == "https://mp.weixin.qq.com/"
    assert seen_headers[0]["user-agent"]


async def test_download_uses_expected_extension_per_mime(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            ["https://cdn.example.com/pic"], tmp_path / "media", client=client
        )

    assert len(stored) == 1
    assert stored[0].local_path.endswith(".jpg")
    assert stored[0].local_path == f"{stored[0].sha256[:2]}/{stored[0].sha256}.jpg"


async def test_download_skips_non_image_payloads(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>nope</html>", headers={"content-type": "text/html"}
        )

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            ["https://cdn.example.com/page"], tmp_path / "media", client=client
        )

    assert stored == []
    assert _files(tmp_path / "media") == []


async def test_download_skips_oversized_images(tmp_path: Path) -> None:
    big = PNG + b"\x00" * 4096

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big, headers={"content-type": "image/png"})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            ["https://cdn.example.com/big.png"],
            tmp_path / "media",
            max_bytes=1024,
            client=client,
        )

    assert stored == []
    assert _files(tmp_path / "media") == []


async def test_download_continues_after_individual_failures(tmp_path: Path) -> None:
    good_url = "https://cdn.example.com/good.png"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/broken.png":
            return httpx.Response(500, text="server error")
        if request.url.path == "/offline.png":
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            [
                "https://cdn.example.com/broken.png",
                "https://cdn.example.com/offline.png",
                good_url,
            ],
            tmp_path / "media",
            client=client,
        )

    assert len(stored) == 1
    assert stored[0].original_url == good_url


async def test_download_dedupes_by_url_and_sha256(tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            [
                "https://cdn.example.com/a.png",
                "https://cdn.example.com/a.png",
                "https://cdn.example.com/b.png",
                "data:image/png;base64,AAAA",
            ],
            tmp_path / "media",
            client=client,
        )

    assert calls == ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"]
    assert len(stored) == 1
    assert stored[0].original_url == "https://cdn.example.com/a.png"
    assert len(_files(tmp_path / "media")) == 1


async def test_download_reuses_existing_file_on_disk(tmp_path: Path) -> None:
    media_dir = tmp_path / "media"
    sha = hashlib.sha256(PNG).hexdigest()
    target = media_dir / sha[:2] / f"{sha}.png"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"pre-existing")
    mtime_before = target.stat().st_mtime_ns

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    async with make_client(handler) as client:
        stored = await media.download_and_store_images(
            ["https://cdn.example.com/a.png"], media_dir, client=client
        )

    assert len(stored) == 1
    assert target.read_bytes() == b"pre-existing"
    assert target.stat().st_mtime_ns == mtime_before


async def test_download_returns_empty_for_empty_input(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("no request expected")

    async with make_client(handler) as client:
        assert await media.download_and_store_images([], tmp_path / "media", client=client) == []
        assert (
            await media.download_and_store_images(
                ["", "   "], tmp_path / "media", client=client
            )
            == []
        )


def test_rewrite_markdown_images() -> None:
    mapping = {
        "https://mmbiz.qpic.cn/img1.png": "/api/media/m1",
        "https://mmbiz.qpic.cn/img2.jpg": "/api/media/m2",
        "https://cdn.example.com/a.png?x=1&y=2": "/api/media/m3",
    }
    markdown = "\n".join(
        [
            "![图一](https://mmbiz.qpic.cn/img1.png)",
            "[普通链接](https://example.com/page)",
            '<img src="https://mmbiz.qpic.cn/img2.jpg" alt="two" />',
            "![](https://cdn.example.com/a.png?x=1&amp;y=2)",
        ]
    )

    rewritten = media.rewrite_markdown_images(markdown, mapping)

    assert "![图一](/api/media/m1)" in rewritten
    assert "![](/api/media/m3)" in rewritten
    assert '<img src="/api/media/m2"' in rewritten
    assert "https://example.com/page" in rewritten
    assert "mmbiz.qpic.cn/img1.png" not in rewritten
    assert rewritten == media.rewrite_markdown_images(rewritten, mapping)


def test_rewrite_markdown_images_from_stored_media() -> None:
    stored = [
        media.StoredMedia(
            id="m1",
            original_url="https://mmbiz.qpic.cn/img1.png",
            local_path="aa/aa.png",
            mime_type="image/png",
            size_bytes=1,
            sha256="aa",
        ),
        {"id": "m2", "original_url": "https://mmbiz.qpic.cn/img2.jpg"},
    ]
    markdown = "![a](https://mmbiz.qpic.cn/img1.png)\n\n![b](https://mmbiz.qpic.cn/img2.jpg)"

    rewritten = media.rewrite_markdown_images(markdown, media=stored)

    assert "![](/api/media/m1)" not in rewritten
    assert "![a](/api/media/m1)" in rewritten
    assert "![b](/api/media/m2)" in rewritten


def test_rewrite_markdown_images_noop_cases() -> None:
    markdown = "![x](https://cdn.example.com/unmapped.png)"
    assert media.rewrite_markdown_images(markdown, {}) == markdown
    assert media.rewrite_markdown_images("", {"https://a/b": "/api/media/1"}) == ""
    assert media.rewrite_markdown_images(markdown, {"https://other/x.png": "/api/media/2"}) == (
        markdown
    )


def test_stored_media_dataclass_defaults() -> None:
    item = media.StoredMedia(
        id="m1",
        original_url="https://cdn.example.com/a.png",
        local_path="ab/abcdef.png",
        mime_type="image/png",
        size_bytes=10,
        sha256="abcdef",
    )
    assert item.sort_order == 0
