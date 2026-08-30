#!/usr/bin/env bash
# Run all tests for ordinary.click (API Lambda, Processor Lambda, Client-Side SPA)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-west-1}"

echo "=== 1. API Handler Tests (lambda/api) ==="
python3 tests/test_api_handler.py

echo ""
echo "=== 2. Processor Lambda Tests (lambda/processor) ==="
if [ -f "$HOME/.venv/bin/activate" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.venv/bin/activate"
fi
python3 tests/test_processor.py

echo ""
echo "=== 3. Frontend SPA Tests (site/) ==="
node --test tests/test_site.js

echo ""
echo "=========================================="
echo "All test suites passed successfully! (3/3)"
echo "=========================================="
