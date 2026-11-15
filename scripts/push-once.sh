#!/usr/bin/env bash
set -euo pipefail
REPO_URL="${1:-https://github.com/Mridul-dhungana/Breadboard-Odyssey.git}"
cd "$(dirname "$0")/.."
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"
git push -u origin main
