# Turning on online lookup (about 10 minutes, free)

The app itself never holds a key. A tiny Cloudflare Worker sits between your phone and the internet, checks your passphrase, and talks to Modrinth, Wikipedia and (optionally) Groq.

## 1. Accounts
- Cloudflare: sign up free at https://dash.cloudflare.com/sign-up (no card needed).
- Groq (optional, only needed for "Ask AI (web)"): https://console.groq.com > API Keys > Create. **Never paste this key into chat or commit it to GitHub.** You will type it into your own terminal below.

## 2. Tell the Worker which website may use it
Open `worker/wrangler.toml` in VS Code and replace `YOUR-USERNAME` so it matches your GitHub Pages address.
It must be the origin only: `https://yourname.github.io` (no trailing slash, no `/brainiac-os`).

## 3. Deploy (VS Code terminal, in the project folder)
```
cd worker
npx wrangler login
npx wrangler secret put APP_PASSPHRASE
npx wrangler secret put GROQ_API_KEY
npx wrangler deploy
```
- `login` opens a browser to approve access.
- `APP_PASSPHRASE`: invent a long random passphrase using only plain letters, numbers and symbols (no spaces, no accents). Save it in a password manager.
- `GROQ_API_KEY`: paste your Groq key at the prompt. Skip this command if you only want Look up online.
- `deploy` prints your address, like `https://brainiac-proxy.something.workers.dev`. If it asks you to choose a workers.dev name, pick one.

Then push the edited file so the repo matches: `cd ..` then `git add .`, `git commit -m "Set Worker origin"`, `git push`.

## 4. Connect the phone
Open the app > SETUP > Online lookup. Enter the Worker address and passphrase, tap Save, then Test connection.
Then go to COMMAND, type `Powerborne` and tap **Look up online**.

## What it does
- **Look up online:** searches Modrinth (mods) and Wikipedia directly. No AI, no Groq key needed.
- **Ask AI (web):** asks Groq's `groq/compound` model, which has built-in web search. It may not be available on every free plan; if Groq refuses, the app says so and Look up online still works. You can change the model with `GROQ_MODEL` in `wrangler.toml`.
- Nothing is saved automatically. "Review & save" opens a pre-filled form, always marked **unverified**, with the source link. You decide.

## What leaves your phone
Your search words, and only if you tick the box, up to 3 matching record names and descriptions (never private notes). They go to your Worker, then to Modrinth, Wikipedia or Groq. Third-party reports say Groq's free tier gives no privacy guarantee, so do not send anything you consider sensitive.

## Limits and honesty
- Free tiers have request limits and can change. Check Cloudflare's current Workers limits and Groq's rate-limit page. Watch usage in the Cloudflare dashboard (Workers & Pages > brainiac-proxy > Metrics) and the Groq console.
- The passphrase is a shared secret, not strong authentication. Anyone who learns it can spend your Groq quota. If it leaks, run `npx wrangler secret put APP_PASSPHRASE` again and update the app.
- The rate limiter (20 requests/minute per IP) is best effort, not a hard guarantee.
- Lookups can be wrong, outdated or about a different thing with the same name. Treat everything as unverified until you confirm it in-game.

## Troubleshooting
| Message | Meaning |
|---|---|
| Wrong passphrase | Passphrase in Setup differs from the Worker secret |
| Worker rejected this website | `ALLOWED_ORIGIN` is wrong or not deployed yet |
| Could not reach the lookup service | Offline, or the Worker address is mistyped |
| Groq rejected the API key / model name | Re-set the secret, or change `GROQ_MODEL` |
| AI rate limit reached | Wait a minute (free tier) |
