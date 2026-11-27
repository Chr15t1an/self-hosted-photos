# What it costs

**Short version:** for most families it's a few dollars a year in storage, plus a domain if you don't already own one.
You pay for storage only beyond the first 10 GB, and viewing and downloading are free.

Prices are Cloudflare's published list prices as of November 2026. Check the linked pages before you rely on them.

## The parts

| Part | What it does here | Price | For a family library |
|---|---|---|---|
| **R2** storage ([pricing](https://developers.cloudflare.com/r2/pricing/)) | holds every original, thumbnail and web version | first **10 GB free** each month, then **$0.015 per GB per month** | the only cost that grows |
| R2 writes ("Class A") | each upload makes a few (one per 50 MB part, plus create, finish, thumbnail and web version) | first 1 million a month free, then $4.50 per million | uploading 20,000 photos uses about 80,000, so $0 |
| R2 reads ("Class B") | each thumbnail, photo or video you view | first 10 million a month free, then $0.36 per million | $0 |
| R2 downloads | serving files to your browser | **free**, with no egress charge | $0 |
| **Workers** ([pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/)) | runs the app | Free plan: 100,000 requests a day. Paid: $5 a month | $0 on Free (see the note below) |
| **D1** ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) | the list of items, tags and dates | free tier, with gigabytes of storage | a 10,000-photo library is a few MB, so $0 |
| **Access** ([plans](https://www.cloudflare.com/plans/zero-trust-services/)) | the login | Free plan: up to 50 people | $0 |
| **Domain** | the app's address | about $10–15 a year for a `.com` (Cloudflare Registrar charges cost price) | $0 if you already own one |

## Storage, the cost that grows

`(GB stored − 10) × $0.015 × 12 months`, rounded:

| You store | Per month | Per year |
|---|---|---|
| 10 GB | $0 | **$0** |
| 20 GB | $0.15 | **$1.80** |
| 50 GB | $0.60 | **$7.20** |
| 100 GB | $1.35 | **$16.20** |
| 250 GB | $3.60 | **$43.20** |
| 500 GB | $7.35 | **$88.20** |
| 1 TB | $14.85 | **$178.20** |

Thumbnails and web versions add about 5–10% on top of a photo library, and almost nothing to a video library.
Billing is by the average stored over the month, so a big upload late in the month costs less that first month.

## A real install

The first install of this app, in November 2026, held **2,815 full-resolution photos** from a few professional photo
shoots, averaging 12 MB each. That came to 33.2 GB of originals plus 2 GB of thumbnails and web versions,
**35.3 GB in all**. It costs $0.38 a month in storage, about **$4.55 a year**. It runs on an account that already
paid $5 a month for Workers Paid for other projects, so the app itself added nothing there.

## Workers Free or Paid?

The app is built to fit the Free plan. Uploads stream straight through to R2 without being held in memory, a
signed-in page load is a few dozen requests, and two people browsing won't come near 100,000 requests a day.
The one Free-plan limit to know about is **10 ms of CPU time per request**. Time spent waiting on R2 or D1 doesn't
count toward it, and nothing in the app is computation-heavy, but this app has so far only been run on Workers Paid. If
you see `Error 1102` ("Worker exceeded resource limits"), switch the account to Workers Paid ($5 a month, which also
raises the request allowance to 10 million a month).

## What it doesn't cost

- **No per-person fee** up to 50 people.
- **No bandwidth bills:** sharing a 4 GB video with family costs nothing to serve.
- **No image-processing fees:** thumbnails and web versions are made on your device when you upload, not by a paid
  Cloudflare service.
- **No lock-in:** everything is ordinary files in your own bucket, and you can copy them out with any S3-compatible
  tool (see [USING.md](USING.md#getting-everything-out)).
