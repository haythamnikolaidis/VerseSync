#!/usr/bin/env bash
# Installs Python and Node dependencies for a fresh agent session. Safe to run twice.
set -euo pipefail
cd "$(dirname "$0")/../.."

python -m pip install -q -e ".[dev]" >/dev/null 2>&1
npm ci --silent --no-audit --no-fund >/dev/null 2>&1
