#!/usr/bin/env bash
# FALLBACK ONLY. Use when `npm ci` is impossible (no network). Compiles src/ + tests/ with a global `tsc`, then runs
# db.test.ts and ui.test.ts in real Chromium (global Playwright) and worker.test.ts in Node, using a tiny vitest-compatible shim.
# It is NOT `npm test`: the shim's expect() is simpler than vitest's, and jsdom/fake-indexeddb are replaced by Chromium's real ones.
# It does not run `vite build`, so the production build and service worker stay unverified.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; export H="${H:-/tmp/brainiac-verify}"; export NODE_PATH="$(npm root -g)"
rm -rf "$H"; mkdir -p "$H/shim" "$H/outw"
cp "$ROOT/tools/offline-verify/vitest-shim.js" "$H/shim/vitest.js"; cp "$ROOT/tools/offline-verify/run.html" "$H/run.html"; echo 'export {}' > "$H/shim/empty.js"
cat > "$H/tsconfig.json" <<J
{"compilerOptions":{"target":"ES2020","module":"ESNext","moduleResolution":"bundler","lib":["ES2020","DOM","DOM.Iterable"],"types":[],"strict":false,"noEmitOnError":false,"skipLibCheck":true,"outDir":"$H/out","rootDir":"$ROOT"},
"include":["$ROOT/src/*.ts","$ROOT/worker/index.ts","$ROOT/tests/*.test.ts"]}
J
tsc -p "$H/tsconfig.json" >/dev/null 2>&1 || true
for f in "$H"/out/src/*.js "$H"/out/worker/*.js "$H"/out/tests/*.js; do
  sed -i -E "s#(from |import\()\s*'(\.[^']*)'#\1'\2.js'#g; s#^import '\./style\.css';##; s#import\.meta\.env#({PROD:false})#g" "$f"; done
echo "== browser tests =="; node "$ROOT/tools/offline-verify/go.cjs" ${BROWSER_TESTS:-db ui ops opsdb coluan opsui migration migration-v2}
echo "== node tests =="; mkdir -p "$H/out/node_modules/vitest"; cp "$H/shim/vitest.js" "$H/out/node_modules/vitest/index.js"
echo '{"name":"vitest","type":"module","main":"index.js"}' > "$H/out/node_modules/vitest/package.json"; echo '{"type":"module"}' > "$H/out/package.json"
cat > "$H/out/run.mjs" <<'J'
import { run } from 'vitest'; for (const f of process.argv.slice(2)) await import(`./tests/${f}.test.js`); const res = await run(); let bad = 0;
for (const r of res) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '\n    ' + r.e)); if (!r.ok) bad++; } console.log(bad ? `${bad} FAILED` : `${res.length} passed, 0 failed`); process.exit(bad ? 1 : 0);
J
FAILED=0
(cd "$H/out" && node run.mjs worker voice) || FAILED=1
# The date logic is run under several time zones, because "off by one day" bugs only show up when the device zone differs from UTC.
for tz in UTC Pacific/Kiritimati Pacific/Auckland Australia/Sydney America/Los_Angeles Pacific/Pago_Pago; do echo "== ops.test under TZ=$tz =="; (cd "$H/out" && TZ=$tz node run.mjs ops | tail -1) || FAILED=1; done
exit $FAILED
