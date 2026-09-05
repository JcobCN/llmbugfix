#!/usr/bin/env bash
# Build an offline deployment archive for this workspace.
#
# Usage:
#   ./scripts/package-offline.sh [archive-path]
#
# With no argument, the archive is written next to the workspace directory.

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT_NAME="$(basename -- "$PROJECT_DIR")"
PROJECT_PARENT="$(dirname -- "$PROJECT_DIR")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# Keeping the archive outside the project prevents tar from including the
# archive while it is being written.  It also means extraction creates the
# project directory itself (for example: llmbugfix/).
ARCHIVE_INPUT="${1:-$PROJECT_PARENT/${PROJECT_NAME}-offline-${TIMESTAMP}.tar.gz}"
ARCHIVE_DIR="$(cd -- "$(dirname -- "$ARCHIVE_INPUT")" && pwd -P)"
ARCHIVE_PATH="$ARCHIVE_DIR/$(basename -- "$ARCHIVE_INPUT")"

case "$ARCHIVE_PATH" in
  "$PROJECT_DIR"/*)
    echo "错误：归档文件必须放在项目目录之外：$ARCHIVE_PATH" >&2
    exit 1
    ;;
esac

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：找不到 pnpm，请先安装与本项目兼容的 pnpm。" >&2
  exit 1
fi

echo "[1/3] 离线安装依赖..."
(
  cd -- "$PROJECT_DIR"
  pnpm install --offline
)

echo "[2/3] 创建部署包：$ARCHIVE_PATH"
# Exclude only generated/tool caches. node_modules is deliberately retained:
# it contains the already-installed dependencies needed by the offline host.
tar \
  --create \
  --gzip \
  --file="$ARCHIVE_PATH" \
  --directory="$PROJECT_PARENT" \
  --exclude="$PROJECT_NAME/.git" \
  --exclude="$PROJECT_NAME/.git/*" \
  --exclude="$PROJECT_NAME/.cache" \
  --exclude="$PROJECT_NAME/.cache/*" \
  --exclude="$PROJECT_NAME/.turbo" \
  --exclude="$PROJECT_NAME/.turbo/*" \
  --exclude="$PROJECT_NAME/.vite" \
  --exclude="$PROJECT_NAME/.vite/*" \
  --exclude="$PROJECT_NAME/.nyc_output" \
  --exclude="$PROJECT_NAME/.nyc_output/*" \
  --exclude="$PROJECT_NAME/coverage" \
  --exclude="$PROJECT_NAME/coverage/*" \
  --exclude="$PROJECT_NAME/test-results" \
  --exclude="$PROJECT_NAME/test-results/*" \
  --exclude="$PROJECT_NAME/playwright-report" \
  --exclude="$PROJECT_NAME/playwright-report/*" \
  --exclude="$PROJECT_NAME/node_modules/.cache" \
  --exclude="$PROJECT_NAME/node_modules/.cache/*" \
  --exclude="$PROJECT_NAME/node_modules/.vite" \
  --exclude="$PROJECT_NAME/node_modules/.vite/*" \
  --exclude="$PROJECT_NAME/.pnpm-store" \
  --exclude="$PROJECT_NAME/.pnpm-store/*" \
  --exclude="$PROJECT_NAME/.eslintcache" \
  --exclude="$PROJECT_NAME/.stylelintcache" \
  --exclude="$PROJECT_NAME/__pycache__" \
  --exclude="$PROJECT_NAME/__pycache__/*" \
  --exclude='*.tsbuildinfo' \
  "$PROJECT_NAME"

echo "[3/3] 校验归档..."
tar --list --gzip --file="$ARCHIVE_PATH" >/dev/null

echo "完成：$ARCHIVE_PATH"
echo "目标机解压：tar -xzf $(basename -- "$ARCHIVE_PATH")"
echo "解压后目录：$PROJECT_NAME/"
