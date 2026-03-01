#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

PACKAGES=(
  "@archi-navi/shared"
  "@archi-navi/db"
  "@archi-navi/core"
  "@archi-navi/inference"
  "@archi-navi/ui"
  "@archi-navi/web"
  "@archi-navi/cli"
)

NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-${ROOT_DIR}/.release/.npm-cache}"
mkdir -p "${NPM_CACHE_DIR}"
export NPM_CONFIG_CACHE="${NPM_CACHE_DIR}"

for pkg in "${PACKAGES[@]}"; do
  echo "[publish] ${pkg} ${DRY_RUN}"
  pnpm --filter "${pkg}" publish --access public --no-git-checks ${DRY_RUN}
done

echo
echo "npm publish sequence complete."
