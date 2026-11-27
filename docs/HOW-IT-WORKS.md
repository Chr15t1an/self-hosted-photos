# How it works

```
 phone / laptop ──► Cloudflare Access (login) ──► Worker (src/index.ts) ──► R2: the files
 uploader (CLI) ──► service token ─────────────┘          │
                                                          └──────────────► D1: items, tags, dates
```

- **Worker** (`src/index.ts`, built on [Hono](https://hono.dev)): serves the web page from `public/`, which has no
  build step, plus a small JSON API and the media routes.
- **R2:** one private bucket. Originals are at `originals/<space>/<YYYY-MM>/<id>.<ext>`, thumbnails (480 px JPEG)
  at `thumbs/<id>.jpg`, and photo web versions (~2048 px JPEG) at `web/<id>.jpg`. The bucket has no public URL; every
  byte goes through the Worker, behind the login.
- **D1:** one `items` table (space, kind, file name, type, size, capture date and where it came from, dimensions,
  duration, social and archived flags, upload status), an `item_tags` table, and `groups` / `group_items` for named,
  ordered sets of items. The schema is in `migrations/`.
- **Cloudflare Access:** the only login. The app has no users, passwords or sessions of its own.

## Uploads

A Worker can't accept a request body over 100 MB, so every upload, from the web or the uploader, goes in pieces:

1. `POST /api/uploads` creates the database row (hidden, `status = uploading`) and an R2 multipart upload.
2. `PUT /api/uploads/:id/parts/:n` sends each piece of up to 50 MB. The Worker streams it into R2 without holding it in
   memory. The uploader sends 4 pieces at a time and retries failures.
3. `POST /api/uploads/:id/complete` assembles the file in R2 and makes the row visible. It refuses unless every piece
   arrived exactly once, and discards the upload if the stored size doesn't match the declared size, so a truncated
   file never appears in the library.
4. `PUT /api/items/:id/thumb` and `/web` store the thumbnail and web version, which the uploading device made.

There are no storage keys on your computer and no pre-signed URLs: the uploader only ever talks to your app, through
the login. Measured on a home connection: 2.77 GB in 126 seconds.

## Thumbnails and web versions

The device that uploads makes them. The browser draws them on a canvas, and the uploader uses macOS `sips` for photos
and `ffmpeg` for video frames. This costs nothing, works for video, and needs no image service. The web version has a
long edge of 2048 px and is never enlarged; it's re-made at 1600 px if it comes out over 1 MB. GIFs get none, so they
keep animating. If a device can't decode a format (desktop Chrome and HEIC), the item is stored without a thumbnail
and the viewer falls back to the original.

## Capture dates

The uploader reads EXIF (photos, via `sips`) or the video's creation time (via `ffprobe`), and falls back to the
file's modified time. It records which one it used (`captured_src`), and the grid sorts by it.

## Security model

- **Two locks.** Cloudflare Access blocks anyone not on the list before a request reaches the Worker. The Worker then
  checks Access's signed token again itself (signature, audience and issuer, in `src/auth.ts`) and admits only an
  email in `OWNER_EMAILS` or the uploader's service token. If the check isn't configured (no `ACCESS_AUD` secret),
  every request gets a 401. It fails closed.
- **Nothing is public.** The config has no `workers.dev` address and no preview URLs. The local-dev config has no
  route at all, so a stray `wrangler deploy` without `--env production` is reachable by nobody.
- **The login exists before the app does.** The deploy creates the Access application before it puts the hostname
  live.
- **Uploaded files can't run code on the app's address.** Only photo and video types are accepted (SVG, HTML, XML and
  scripts are refused). Media is served with `nosniff` and a sandboxing Content-Security-Policy, and anything that
  isn't a plain `image/*` or `video/*` is served as a download.
- **The social pool is enforced in the database.** A `CHECK` constraint makes "Family and OK for social" impossible to
  store, and the `social_pool` view is the only thing a curation tool should read.

## Files

```
src/index.ts              the Worker: login check, items/tags/upload/media API, static page
src/auth.ts               Cloudflare Access token verification
public/                   the web page: index.html, app.js, app.css (no build step)
cli/photos.mjs            the uploader: no dependencies (Node 22+, optional sips and ffmpeg)
migrations/               the D1 schema
scripts/setup.mjs         one-time setup: bucket, database, wrangler.jsonc
scripts/deploy.mjs        login + uploader token + database + deploy + smoke test
scripts/config.mjs        shared settings and credentials lookup
scripts/local-access.mjs  a stand-in Access login for local development
scripts/leak-check.mjs    blocks a push that would publish install-specific or personal details
wrangler.example.jsonc    the template setup fills in
```
