#!/usr/bin/env bash
# Usage: tools/make-checkpoint.sh <name>   e.g. tools/make-checkpoint.sh brainiac-os-checkpoint-4
# Zips the project WITHOUT node_modules, dist, .env/.dev.vars, .wrangler, other zips; then scans the result for secrets.
set -euo pipefail
name="${1:?give a checkpoint name}"; here="$(cd "$(dirname "$0")/.." && pwd)"; out="${OUT_DIR:-$here/..}/$name.zip"; rm -f "$out"
cd "$here/.."; base="$(basename "$here")"
zip -qr "$out" "$base" -x "$base/node_modules/*" "$base/dist/*" "$base/.env" "$base/.env.*" "$base/.dev.vars" "$base/.wrangler/*" "$base/worker/node_modules/*" "$base/*.zip" "$base/test-results/*" "$base/playwright-report/*"
echo "created $out ($(du -h "$out" | cut -f1))"
# secret scan on the zip contents (key shapes and private keys). Matches in test files that use the fake value gsk_SECRET are expected and ignored.
tmp="$(mktemp -d)"; unzip -q "$out" -d "$tmp"
if grep -RInE --exclude-dir=node_modules '(gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,})' "$tmp" ; then echo "SECRET-LIKE STRING FOUND"; rm -rf "$tmp"; exit 1; fi
echo "secret scan: nothing found"; unzip -l "$out" | grep -E "node_modules|/dist/|\.env|\.dev\.vars|\.wrangler" && { echo "EXCLUDED FILE PRESENT"; exit 1; } || echo "exclusion check: ok"; rm -rf "$tmp"
