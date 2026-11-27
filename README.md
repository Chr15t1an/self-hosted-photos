# photo-app

**A private family photo and video library that runs on your own Cloudflare account.** It costs a few dollars a
year, has no subscription, and nobody else holds your photos.

## Why use this instead of a free photo app?

- **The free tiers are small.** Google Photos' free 15 GB is shared with Gmail, and iCloud's free tier is 5 GB. One
  professional photo shoot can be 30 GB. Here, 100 GB costs about $16 a year, and viewing and downloading are free.
- **Your files, your bucket.** You keep plain originals in your own storage. No company scans them, uses them for
  ads or training, or changes the plan on you.
- **Built for full-size video.** Multi-GB clips upload at full quality, resume if the connection drops, and play from
  any point.
- **Family stays separate.** Family photos can never be marked OK for social, so a shareable pool for posts is kept
  apart by design.
- **No server to run.** Self-hosted options like Immich need a computer that's always on. This runs entirely on
  Cloudflare, and setting it up is two commands.

**Where the free apps win:** automatic phone backup in the background, face and place search, and shared albums with
people outside your list. This app has none of those yet.

## What you get

- **Two spaces:** *Family* for the people closest to you, and *Library* for trips, events and everything else.
- **A social pool:** an "OK for social" switch on Library items, off by default, and impossible to switch on for
  Family.
- **A fast grid and viewer** on phone and laptop: small thumbnails, ~1 MB web versions of each photo, video that
  streams and seeks, and the untouched original whenever you download.
- **Tags, archive, capture dates** read from the photo or video itself, and **delete** when you mean it.
- **Groups and sharing:** gather photos into named groups and send them to WhatsApp, Messages, AirDrop or Facebook
  from your phone's share sheet. Copies go from your device, and nothing becomes a public link.
- **A login only your people pass:** Cloudflare Access with a one-time code by email. No passwords, free for up to 50
  people.

## What it costs

| You store | Per year |
|---|---|
| up to 10 GB | $0 |
| 20 GB | $1.80 |
| 100 GB | $16.20 |
| 1 TB | $178.20 |

That's storage, plus a domain if you don't have one (about $10 a year). Everything else fits Cloudflare's free tiers
for a family. The full breakdown is in [docs/COST.md](docs/COST.md).

## Install it

**Have your AI coding agent do it (recommended).** Open this repo in Claude Code, Codex, Cursor or any coding agent and
say *"Follow AGENTS.md and set this up for me."* [AGENTS.md](AGENTS.md) tells it exactly what to do, and when it has to stop and ask you
something. You'll do a few clicks in the Cloudflare dashboard that only you can do, such as turning things on and
creating a token. The agent does the rest and checks its work. Afterwards, ask it to upload a folder or add a person.

**Or do it yourself.** The by-hand instructions for humans are in [docs/SETUP.md](docs/SETUP.md): about 20 minutes,
mostly in the Cloudflare dashboard, then two commands:

```bash
npm install
npm run setup -- --host photos.example.com --emails you@example.com,partner@example.com
npm run deploy
```

## Docs

- [AGENTS.md](AGENTS.md): setup and day-to-day use, written for an AI agent to follow.
- [docs/SETUP.md](docs/SETUP.md): setup by hand, the API token's permissions, and troubleshooting.
- [docs/USING.md](docs/USING.md): uploading, browsing, groups and sharing, adding people, and getting everything out.
- [docs/COST.md](docs/COST.md): what it costs and why.
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): how it's built, how uploads work, and the security model.

## License

MIT. See [LICENSE](LICENSE).
