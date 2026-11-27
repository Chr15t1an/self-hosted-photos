# Setting up your own photo-app (by hand)

Prefer to have an AI coding agent do this? Point it at [AGENTS.md](../AGENTS.md). This page is the same setup for
humans.

This takes about 20 minutes, and most of it is clicking through the Cloudflare dashboard once. When you're done you'll
have the app live at a hostname you choose, such as `photos.example.com`, with only the people you list able to sign in.

## What you need

- **A Cloudflare account.** The free account is enough to start (see [COST.md](COST.md)).
- **A domain on that Cloudflare account.** The app lives on a subdomain of it, such as `photos.yourfamily.com`. If you
  already have a domain somewhere else, add it to Cloudflare (dashboard → **Add a domain**) and change its nameservers
  to the two Cloudflare gives you. If you don't have one, you can buy one in the dashboard under **Domain
  Registration**; Cloudflare charges what the registry charges, about $10 a year for a `.com`.
- **A payment method on the account.** Cloudflare requires one to turn on R2 storage, even though the first 10 GB are
  free.
- **Node 22 or later** on your computer (`node --version`).
- **For the uploader, optionally:** a Mac, plus `ffmpeg` (`brew install ffmpeg`). The uploader works anywhere Node
  runs, but it makes photo thumbnails with macOS's built-in `sips`. On Linux or Windows, photos upload without a
  thumbnail or web version, and the app falls back to the original. Uploading from the web page works the same
  everywhere.

## Step 1: Turn on R2 and Cloudflare Access (once, in the dashboard)

1. **R2:** dashboard → **R2 Object Storage** → turn it on. It asks for the payment method.
2. **Access:** dashboard → **Zero Trust**. The first time, it asks you to pick a **team name** (any name; it becomes
   `<team>.cloudflareaccess.com`, the address of your login page) and a plan. Pick **Free**, which covers up to 50
   people.
3. **Email codes:** in Zero Trust → **Settings → Authentication**, check that **One-time PIN** is in the list of
   login methods. New accounts have it already. It is what lets people sign in with a code sent to their email.

## Step 2: Make an API token

Dashboard → **My Profile → API Tokens → Create Token**. Start from the **Edit Cloudflare Workers** template, then add
the extra permissions so the list is:

| Type | Permission | Access | What it's for |
|---|---|---|---|
| Account | Workers Scripts | Edit | deploy the app |
| Account | Workers R2 Storage | Edit | create the storage bucket |
| Account | D1 | Edit | create the database and apply its schema |
| Account | Account Settings | Read | find your account |
| Account | Access: Apps and Policies | Edit | create the login and its list of people |
| Account | Access: Service Tokens | Edit | create the uploader's credentials |
| Account | Access: Organizations, Identity Providers, and Groups | Read | find your login page's address |
| Zone | Workers Routes | Edit | put the app on your hostname |
| Zone | Zone | Read | find your domain |
| Zone | DNS | Edit | only needed for `deploy --replace-dns` |
| User | User Details, Memberships | Read | part of the template; used by `wrangler` |

Limit **Account Resources** to your account and **Zone Resources** to your domain. Copy the token. Then, in the
terminal you'll use:

```bash
export CLOUDFLARE_API_TOKEN=…
```

If you'd rather keep the Access permissions on a separate token, make a second one with just the three Access rows
and set it as `CLOUDFLARE_ACCESS_API_TOKEN`. The scripts use it for Access and the main token for everything else.

To avoid pasting it every time, you can put `CLOUDFLARE_API_TOKEN=…` in `~/.config/photos/credentials.env`
instead. The scripts read that file, and it's the same file the deploy writes the uploader's credentials into. Keep
it private: `chmod 600 ~/.config/photos/credentials.env`.

## Step 3: Get the code and run setup

```bash
git clone <this repo> photo-app
cd photo-app
npm install
npm run setup -- --host photos.example.com --emails you@example.com,partner@example.com
```

Use your own hostname and the emails of everyone who should be able to sign in. Setup:

- finds your account. If your token sees more than one, it lists them; re-run with `--account <id>`.
- checks your domain is on that account.
- finds your Access team's login address.
- creates a **private** R2 bucket called `photo-app-originals`, or reuses it if it's there.
- creates a D1 database called `photo-app`, or reuses it if it's there.
- writes `wrangler.jsonc`, the one file that holds your install's settings.

Nothing is live yet. Options: `--name` changes the app's name (default `photo-app`; the bucket becomes
`<name>-originals`), `--bucket` picks the bucket name, and `--force` overwrites an existing `wrangler.jsonc`.

## Step 4: Deploy

```bash
npm run deploy
```

The deploy does these steps, in this order, and each one is safe to repeat:

1. **Checks the hostname is free.** If `photos.example.com` already has a DNS record, it stops and changes nothing.
   Delete the old record in the dashboard, or run `npm run deploy -- --replace-dns` once you're sure it's unused.
2. **Creates the uploader's credentials.** This is a Cloudflare Access *service token* called `photo-app-cli`. It's
   saved to `~/.config/photos/credentials.env`, along with your app's address. It lasts one year (see
   [USING.md](USING.md#once-a-year-renew-the-uploaders-credentials)).
3. **Creates the login.** This is an Access application on your hostname that lets in exactly the emails in
   `wrangler.jsonc`, plus the uploader's token. A sign-in lasts 30 days.
4. **Sets up the database and deploys the app.**
5. **Checks it.** A request with no sign-in must get the login page, and the uploader's token must get through.

The login is created **before** the hostname goes live, so the app is never reachable without it. The app also checks
the sign-in itself and refuses everything if that check isn't set up.

## Step 5: Sign in

Open `https://photos.example.com`. You'll see your Cloudflare Access login page. Enter one of the emails you listed,
then type in the code it sends. You should see an empty library with **Family** and **Library** tabs.

Try the uploader:

```bash
npm run photos -- upload ~/Pictures/some-folder --dry-run    # shows what it would do
npm run photos -- upload ~/Pictures/some-folder               # does it (into Family by default)
```

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| `setup`: "Cloudflare Access isn't set up on this account yet" | You haven't opened Zero Trust and picked a team name yet | Step 1.2, then run setup again |
| `setup`: "Couldn't read R2" | R2 isn't turned on | Step 1.1 |
| `setup`: "No zone on this account covers…" | The domain isn't on this Cloudflare account | Add it (see "What you need") |
| `deploy`: "Your token can't manage Access" | The token is missing an Access permission | Add the Access rows in step 2 |
| `deploy`: "…already has DNS records…" | Something else already uses that hostname | Pick another hostname in `wrangler.jsonc`, or `--replace-dns` |
| `deploy`: "Service token photo-app-cli exists but its secret is not in…" | The credentials file was lost or is on another computer | Zero Trust → Access → Service auth → delete `photo-app-cli`, then deploy again |
| The login page never sends a code | One-time PIN is off | Step 1.3 |
| Signed in, but the app says 403 | Your email isn't in `OWNER_EMAILS` | Add it, then `npm run deploy` |

## Running it locally (for changing the code)

`npm run dev` runs the app on your computer at `http://127.0.0.1:8788`, using your **real** bucket and database, so
anything you upload locally is really stored. Use a stand-in for the login:

```bash
printf 'ACCESS_AUD=local-test\nACCESS_TEAM_DOMAIN=http://127.0.0.1:8797\nACCESS_SERVICE_CLIENT_IDS=local-svc.access\n' > .dev.vars
npm run local-access -- .wrangler/jwt     # serves signing keys and writes test sign-ins to .wrangler/jwt/
npm run dev
```

In the browser, set a `CF_Authorization` cookie for `127.0.0.1` to the contents of `.wrangler/jwt/owner.jwt`. For the
uploader: `PHOTOS_URL=http://127.0.0.1:8788 PHOTOS_JWT_FILE=.wrangler/jwt/service.jwt npm run photos -- upload …`.
