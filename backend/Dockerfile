# syntax=docker/dockerfile:1
# 剪藏 (Jiancang) 后端镜像 —— 面向家用 Ubuntu NUC (x86_64) 自托管部署
# 构建上下文固定为 ./backend，构建入口见仓库根目录 docker-compose.yml。
#
# 关键设计：
#   1) python:3.12-slim：体积小，且自带编译了 FTS5 + trigram 分词器的 SQLite（中文全文检索依赖它）
#   2) uv 二进制直接从官方镜像 COPY，不在 slim 里 curl 下载（NUC 上更稳更快）
#   3) 先依赖层、后代码层，改 app/ 代码不会触发重新装依赖
#   4) 非 root 运行（UID/GID 1000，对齐 Ubuntu 默认用户，Bind Mount 的 ./data 读写不打架）

FROM python:3.12-slim

# ---- 国内 PyPI 镜像：默认清华源，可用 --build-arg UV_INDEX_URL=... 覆盖 ----
ARG UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_INDEX_URL=${UV_INDEX_URL} \
    UV_DEFAULT_INDEX=${UV_INDEX_URL} \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/app/.venv/bin:${PATH}"

# 从国内 PyPI 镜像装 uv（避免国内拉 ghcr.io 卡顿）
RUN pip install --no-cache-dir -i "${UV_INDEX_URL}" uv

WORKDIR /app

# ---- 依赖层（缓存命中率高：只有 pyproject.toml / uv.lock 变化才重装）----
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --no-install-project

# ---- 业务代码层 ----
COPY app ./app

# ---- 非 root 运行 + 数据目录 ----
ARG APP_UID=1000
ARG APP_GID=1000
RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown -R "${APP_UID}:${APP_GID}" /app

USER app
# HOME 指向 /app，避免 uvicorn/httpx 在无 home 目录时写缓存告警
ENV HOME=/app \
    DATA_DIR=/app/data

EXPOSE 8420

# /health 是后端就绪探针；显式禁用代理确保 127.0.0.1 必直连
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request, os\ntry:\n    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))\n    ok = opener.open(os.environ.get('HEALTHCHECK_URL', 'http://127.0.0.1:8420/health'), timeout=4).status == 200\nexcept Exception:\n    ok = False\nsys.exit(0 if ok else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8420"]
