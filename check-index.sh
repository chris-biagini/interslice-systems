#!/usr/bin/env bash
# Verify every module in this directory is imported by index.md.
# Exits non-zero if any module is missing from the index.

set -euo pipefail

cd "$(dirname "$0")"

fail=0
count=0
for f in *.md; do
  case "$f" in
    README.md|index.md) continue ;;
  esac
  count=$((count + 1))
  if ! grep -qF "@./$f" index.md; then
    echo "drift: $f is not imported by index.md" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "index.md is in sync ($count modules)"
fi
exit "$fail"
