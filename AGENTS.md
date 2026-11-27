# AGENTS.md: setting up and running photo-app for your human

You are an AI coding agent. Your human wants this private photo and video library running on **their own Cloudflare
account**. This file is your runbook: what to do, in what order, what only the human can do, and how to prove each step
worked. Do the work yourself, and stop only at the points marked **ASK** or **HUMAN**.

Read [README.md](README.md) for what the app is. The by-hand version of these steps, with the same facts, is
[docs/SETUP.md](docs/SETUP.md). When this file and that one disagree, trust the code in `scripts/`.

## Ground rules

- **Never print, log or commit a secret.** Secrets here are the Cloudflare API token(s) and the uploader's service
  token (`PHOTOS_CLIENT_ID` / `PHOTOS_CLIENT_SECRET`). Pass them through environment variables or
  `~/.config/photos/credentials.env` (keep it `chmod 600`). Never put one on a command line that gets echoed, in a
  file in this repo, or in chat.
- **`wrangler.jsonc` holds this install's account id, database id, hostname and emails.** It's made by `npm run setup`.
  It's in `.gitignore`; keep it out of any public fork.
- **Never make the R2 bucket public** or add a public URL, `workers_dev` or `preview_urls`. Every byte must go through
  the Worker, behind Access.
- **Never run `wrangler login`.** Use an API token, as described below.
- **Going live is the human's decision.** Ask before the first `npm run deploy` (it puts the app on their hostname),
  before `--replace-dns` (it deletes a DNS record), and before deleting any photos.
- If a step fails, read the error. The scripts' errors say what's missing. Fix the cause and re-run the step. Every
  script is safe to re-run.

## What you need from the human (ASK, all at once, at the start)

1. **The hostname** for the app, e.g. `photos.theirfamily.com`. It must be on a domain that's already on their
   Cloudflare account, or that they're willing to add or buy.
2. **The emails** of everyone who should be able to sign in, including their own.
3. **Which computer uploads from.** The uploader makes photo thumbnails with macOS `sips`; on Linux or Windows, photos
   upload without thumbnails or web versions, and the web viewer falls back to originals. Uploading from the web page
   works everywhere.

## Step 1: Check the machine

```bash
node --version          # must be 22 or later
npm install
command -v ffmpeg ffprobe || echo "optional: install ffmpeg for video thumbnails (macOS: brew install ffmpeg)"
```

`npm install` should finish with no errors. `npx tsc` should print nothing; it's the type check.

## Step 2: The dashboard steps (HUMAN)

These need the human's login, a payment method, or a choice only they can make, so you can't do them. Give the human
this list, then wait until they say it's done:

1. **Domain:** the domain must show in the Cloudflare dashboard under **Websites** as *Active*. If it's at another
   registrar, they add it to Cloudflare and change the nameservers, which can take up to a day. If they need a new
   one, they can buy it under **Domain Registration**.
2. **R2:** dashboard → **R2 Object Storage** → turn it on. It needs a payment method; the first 10 GB are free.
3. **Zero Trust:** dashboard → **Zero Trust**. Pick a **team name** and the **Free** plan. Then in **Settings →
   Authentication**, make sure **One-time PIN** is listed as a login method.
4. **API token:** **My Profile → API Tokens → Create Token**, starting from the **Edit Cloudflare Workers** template,
   with these permissions added, Account Resources limited to their account and Zone Resources limited to their
   domain:
   - Account: **Workers Scripts** Edit, **Workers R2 Storage** Edit, **D1** Edit, **Account Settings** Read,
     **Access: Apps and Policies** Edit, **Access: Service Tokens** Edit, **Access: Organizations, Identity
     Providers, and Groups** Read
   - Zone: **Workers Routes** Edit, **Zone** Read, **DNS** Edit
   - User: **User Details** Read, **Memberships** Read

   Have them put the token in `~/.config/photos/credentials.env` themselves, as `CLOUDFLARE_API_TOKEN=…`, then run
   `chmod 600 ~/.config/photos/credentials.env`. That way it never passes through the chat. Or they can export it in
   your shell. The scripts read the environment first, then that file.

Check the token works without revealing it:

```bash
node -e 'import("./scripts/config.mjs").then(async m=>{const t=m.credential("CLOUDFLARE_API_TOKEN");if(!t)throw "no token";const a=await m.cfApi(t,"/accounts");console.log("token OK, accounts:",a.map(x=>x.name).join(", "))})'
```

## Step 3: Setup

```bash
npm run setup -- --host <hostname> --emails <email1>,<email2>
```

Success looks like a column of `✓` lines (account, domain, Access team, R2 bucket, D1 database), then `✓ wrote
wrangler.jsonc`. It creates the bucket and the database if they're missing, and reuses them if they exist. Nothing is
public yet.

| Error | Meaning | Do |
|---|---|---|
| "Your token sees N accounts" | more than one account | ASK which one, then re-run with `--account <id>` |
| "No zone on this account covers …" | the domain isn't on that account | back to Step 2.1 |
| "Cloudflare Access isn't set up …" | no Zero Trust team yet, or the token lacks the Access read permission | Step 2.3, or fix the token |
| "Couldn't read R2" | R2 not turned on | Step 2.2 |
| "wrangler.jsonc already exists" | setup has run before | read it; only re-run with `--force` if the values are wrong |

## Step 4: Deploy (ASK first)

Tell the human, in one line, what's about to happen: *"This puts the app live at https://<hostname>, behind a login
that only <emails> can pass."* Wait for their go, then:

```bash
npm run deploy
```

It does these steps in order: refuse if the hostname already has a DNS record; create the uploader's service token
and save it to `~/.config/photos/credentials.env`; create the Access login; apply the database schema; deploy; then a
smoke test. Success is these two lines at the end:

```
no credentials → 302 (Access login, good)
service token → 200 {"who":"service:…"}
```

If the first line says anything other than "Access login, good", **stop and tell the human**: the app may be
reachable without a login. If the hostname already has a DNS record, the deploy refuses and changes nothing. Show the
human the record it found and ASK before re-running with `--replace-dns`, which deletes it.

## Step 5: Prove it end to end

```bash
mkdir -p /tmp/photo-smoke && sips -s format jpeg -z 64 64 "$(ls /System/Library/Desktop\ Pictures/*.heic | head -1)" --out /tmp/photo-smoke/smoke.jpg   # macOS; elsewhere, use any small JPEG
npm run photos -- upload /tmp/photo-smoke --space library --tag smoke-test
npm run photos -- upload /tmp/photo-smoke --space library --tag smoke-test   # second run must say it was skipped
```

Then have the **HUMAN** open `https://<hostname>`, sign in with their email and the code it sends, and confirm they
see the smoke-test photo in **Library**. You can't do the email login for them. Afterwards, offer to delete the test
photo; it's in the viewer, and deleting it is permanent.

Report back with: the URL, who can sign in, what you verified (the two smoke lines, the upload, the skip), and what
only the human verified (the browser login).

## Running it afterwards

| The human asks | You do |
|---|---|
| "Upload this folder" | `npm run photos -- upload <path> --space family\|library --tags a,b`. Default space is **family**; ASK if it's unclear whether something belongs in Family or Library. Use `--dry-run` first for big folders. If it stops, re-run the same command and it resumes. |
| "Add / remove a person" | edit `OWNER_EMAILS` in `wrangler.jsonc` (the line marked `── WHO CAN SIGN IN ──`), then `npm run deploy` (ASK first: it changes who can see the photos) |
| "Photos load slowly" | `npm run photos -- backfill-web` makes web versions for photos that lack them |
| "The uploader says Access rejected the service token" | it expired (it lasts a year): delete `photo-app-cli` in Zero Trust → Access → Service auth (HUMAN, or with the API), remove the two `PHOTOS_CLIENT_*` lines from `~/.config/photos/credentials.env`, then `npm run deploy` |
| "Update the app" | `git pull && npm install && npm run deploy` |
| "Back everything up" | see [docs/USING.md](docs/USING.md#getting-everything-out) |
| "Mark photos for social" | that's in the web viewer; there's no CLI for it, on purpose |

Never move items from Library into Family, or turn on OK-for-social, unless the human asked for those specific items.

## Changing the code

- **If your human's fork is public,** run `npm run hooks` once. It installs a pre-push check (`scripts/leak-check.mjs`)
  that blocks a push containing their account ids, hostname, emails, home-directory paths, or anything they list in
  `~/.config/photos/leak-deny.txt`. Also set a repo-local git identity that doesn't expose a personal email
  (`git config user.email <id>+<user>@users.noreply.github.com`).

- `src/index.ts` is the Worker; `public/` is the web page (no build step); `cli/photos.mjs` is the uploader;
  `migrations/` is the D1 schema. Add a new numbered migration rather than editing an old one.
- Type check with `npx tsc`. Run locally with `npm run dev` and the stand-in login described in
  [docs/SETUP.md](docs/SETUP.md#running-it-locally-for-changing-the-code). Local dev uses the **real** bucket and
  database, so test uploads are real.
- Don't loosen the security model in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#security-model): the Worker's own
  Access check, failing closed, no public URLs, the media type allow-list, and the Family/social database constraint.
