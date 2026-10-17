#!/usr/bin/env bash
# Runs every check CI runs, in order, stopping at the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

python -m ruff check sidecar tools tests
python -m mypy
python -m pytest -q
npm run lint
npm test
