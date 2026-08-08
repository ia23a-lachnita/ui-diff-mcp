#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RESULT=$(node --input-type=module -e "
import { checkPackageBinPolicy } from './scripts/lib/package-bin-policy.mjs';
const r = checkPackageBinPolicy('package.json', 'package-lock.json');
console.log(JSON.stringify(r));
" 2>&1) || {
  echo "FAIL: node invocation failed" >&2
  echo "$RESULT" >&2
  exit 1
}

OK=$(echo "$RESULT" | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(data.ok ? 'true' : 'false');
")

if [ "$OK" != "true" ]; then
  echo "FAIL: package-bin policy check failed" >&2
  echo "$RESULT" >&2
  exit 1
fi

echo "PASS: package-bin policy check OK"
