#!/usr/bin/env bash
# FALLBACK ONLY, for machines/sandboxes where `npm ci` is impossible. It is NOT `npm run build`: it bundles src/main.ts with esbuild (found inside a global `tsx`)
# at target safari15 (the newest iOS an iPhone 7 can run; the esbuild found here is newer than the one Vite 5.4 pins and refuses to downlevel destructuring for safari14, so the real `npm run build` target in vite.config.ts is unchanged and was NOT exercised) and writes a dist/ with the same shape as Vite's (./assets/index-<hash>.js + .css, public/ copied),
# so tools/offline-verify/*.cjs can exercise it. On your laptop use `npm run build` instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; ES="$(npm root -g)/tsx/node_modules/@esbuild/linux-x64/bin/esbuild"; [ -x "$ES" ] || { echo "esbuild not found"; exit 2; }
rm -rf "$ROOT/dist"; mkdir -p "$ROOT/dist/assets"
"$ES" "$ROOT/src/main.ts" --bundle --minify --format=esm --target=safari15 --define:import.meta.env.PROD=true --define:import.meta.env.DEV=false --loader:.css=css --outdir="$ROOT/dist/assets" --entry-names=index-[hash] --log-level=warning
cp -r "$ROOT/public/." "$ROOT/dist/"
JS=$(cd "$ROOT/dist/assets" && ls index-*.js | head -1); CSS=$(cd "$ROOT/dist/assets" && ls index-*.css | head -1)
sed -e "s#<script type=\"module\" src=\"/src/main.ts\"></script>#<script type=\"module\" crossorigin src=\"./assets/$JS\"></script><link rel=\"stylesheet\" crossorigin href=\"./assets/$CSS\">#" "$ROOT/index.html" > "$ROOT/dist/index.html"
grep -q "assets/$JS" "$ROOT/dist/index.html" && echo "dist/ written: $JS $CSS ($(du -k "$ROOT/dist/assets/$JS" | cut -f1) kB js)"
