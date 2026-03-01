#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/.release/tarballs"

PACKAGES=(
  "@archi-navi/shared"
  "@archi-navi/db"
  "@archi-navi/core"
  "@archi-navi/inference"
  "@archi-navi/ui"
  "@archi-navi/web"
  "@archi-navi/cli"
)

mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/*.tgz

for pkg in "${PACKAGES[@]}"; do
  echo "[pack] ${pkg}"
  pnpm --filter "${pkg}" pack --pack-destination "${OUT_DIR}"
done

echo
echo "완료: ${OUT_DIR}"
ls -1 "${OUT_DIR}"/*.tgz
