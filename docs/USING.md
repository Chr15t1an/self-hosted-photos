# Using photo-app

## Signing in

Open your app's address. Cloudflare's login page asks for your email and sends you a code, and a sign-in lasts 30
days on that device. Only the emails listed in `wrangler.jsonc` get in. Anyone else is turned away by Cloudflare
before they ever reach the app.

**On a phone:** open the address in Safari or Chrome, sign in once, then use **Share → Add to Home Screen** so it
opens like an app.

## The two spaces

- **Family:** for photos of the people closest to you. Nothing in Family can ever be marked OK for social, and the
  database refuses it as well.
- **Library:** everything else: trips, events and b-roll. Each item has an **OK for social** switch, off until you turn
  it on.

The uploader puts things in **Family** unless you say `--space library`. It defaults to the safe side, so nothing
lands in the shareable space by accident. Moving an item from Library to Family turns its social switch off.

## Uploading

**From the web page:** press **Upload** and pick files. Anything you type in **Tags for this upload** goes on every
file in the batch. Files already in the library (same name and size) are skipped. Uploads of any size work, in 50 MB
pieces, but keep the page open until they finish.

**From the uploader** (better for whole folders, big videos, and anything you don't want to babysit):

```bash
npm run photos -- upload <files or folders>... [--space family|library] [--tag t]... [--tags a,b] [--dry-run]
```

```bash
npm run photos -- upload ~/Movies/beach-trip --space library --tags beach,summer   # a trip, into Library
npm run photos -- upload ~/Desktop/birthday.mov --space family --tag birthday     # one big family video
npm run photos -- upload ~/Pictures/export --dry-run                              # show what it would do
```

- Folders are read all the way down. Only photo and video files are uploaded (JPEG, PNG, HEIC, WebP, GIF, TIFF, DNG,
  MP4, MOV, M4V, WebM, MKV, AVI, 3GP), and hidden files are skipped.
- Files already uploaded (same name and size) are skipped, so running the same folder again is safe.
- **If it stops partway,** because of Wi-Fi, a closed laptop or Ctrl-C, run the same command again. It remembers the
  finished pieces (in `~/.config/photos/uploads.json`) and carries on. An unfinished upload stays hidden from the
  library, and Cloudflare clears it after 7 days if you never finish it.
- The social switch is set in the web page, not the uploader, on purpose.
- **Older photos without a web version:** `npm run photos -- backfill-web` makes the fast-loading version for every
  photo that lacks one. It's safe to re-run.

**iPhone photos (HEIC):** uploading from Safari on the iPhone itself converts them to JPEG. From a Mac, use the
uploader, which reads HEIC. Desktop Chrome can't read HEIC, so a HEIC uploaded there gets no thumbnail and the grid
shows its file name instead.

## Browsing

- **Tabs** switch between Family and Library. The grid loads more as you scroll.
- **Filters:** pick a tag, show only OK-for-social items, or show archived items.
- **The viewer:** tap any item. Photos open as their fast web version; **Download** always gives you the full
  original. Videos stream, and you can jump anywhere in a long video without loading all of it.
- **In the viewer** you can add or remove tags, archive (hide from the grid but keep it), move between spaces, switch
  OK for social on or off (Library only), and **delete**. Delete is permanent: the original, thumbnail and web version
  are removed from storage, after you confirm.

## Selecting, groups and sharing

- **Select:** tap **Select**, then tap photos. A ✓ marks each one, and they're kept in the order you picked. Then choose
  **Share**, **Add to group** or **Done**. Your selection stays while you change filters within a space.
- **Groups** (the tab next to Library): a named, ordered set of items from either space, such as "Best of the
  summer" or "For the year-end post". In a group you can **Share all**, select and share or remove items, rename it,
  or delete the group. Deleting a group keeps the photos. Being in a group changes nothing else about an item: not
  its space, and not its OK-for-social switch.
- **Share** (also in the viewer) hands the photos to your phone's share sheet, so WhatsApp, Messages, AirDrop or
  Facebook get real photo files. It sends the fast web versions (about 0.7 MB each) unless you tick **originals**.
  Videos go as their original and are skipped over 200 MB. It takes two taps: the first gets the files ready and the
  second opens the share sheet, because the browser only allows sharing right after a tap. More than 30 items go in
  batches of 30. A browser that can't share files, such as Firefox or an older desktop browser, downloads them
  instead.
- **Nothing becomes public.** Sharing sends copies from your device, and every photo in the app still sits behind
  the login. There are no public share links.

## Adding or removing a person

1. Open `wrangler.jsonc` and find the line marked **`── WHO CAN SIGN IN ──`**.
2. Edit the comma-separated list: `"OWNER_EMAILS": "you@example.com,partner@example.com,grandma@example.com"`.
3. Run `npm run deploy`.

That one line drives both the Cloudflare login and the app's own check, so the two can't disagree. Everyone on the list
can see and change everything. There are no per-person permissions.

## Uploading from another computer

The uploader needs two things, both in `~/.config/photos/credentials.env` on the computer that ran the deploy:
`PHOTOS_URL`, and the token pair `PHOTOS_CLIENT_ID` / `PHOTOS_CLIENT_SECRET`. Copy that file to the same place on
the other computer (`chmod 600` it), or set those three as environment variables there. Treat the token like a
password: anyone with it can upload and delete.

## Once a year: renew the uploader's credentials

The uploader's token (`photo-app-cli`) lasts **one year** from the first deploy. When it runs out, the uploader
stops with "Access rejected the service token". The web page keeps working. To renew it:

1. Dashboard → **Zero Trust → Access → Service auth** → delete `photo-app-cli`.
2. Remove the `PHOTOS_CLIENT_ID` and `PHOTOS_CLIENT_SECRET` lines from `~/.config/photos/credentials.env`.
3. `npm run deploy`. It makes a new token and saves it.

## Updating the app

Pull the new code, then `npm install && npm run deploy`. The deploy applies any new database changes before it
deploys the new code. Your photos and settings aren't touched.

## Getting everything out

Your files are plain objects in your own R2 bucket, named by space and month:
`originals/<family|library>/<YYYY-MM>/<id>.<ext>`. Thumbnails are in `thumbs/` and web versions in `web/`. To copy
everything to a drive, make an **R2 API token** (dashboard → R2 → Manage API tokens, read-only) and use any
S3-compatible tool, for example:

```bash
rclone copy r2:photo-app-originals/originals ./photo-backup    # with an rclone "r2" remote set up for R2
```

The tags, dates and original file names live in the D1 database. To export them:
`npx wrangler d1 export photo-app --remote --output photos.sql`.
