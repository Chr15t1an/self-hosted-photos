#!/usr/bin/env node
// photos: upload photos and videos of any size to the photo app (R2 multipart, 50 MB parts through the Worker).
//
//   node cli/photos.mjs upload <file|folder>... [--space family|library] [--tag t]... [--tags a,b]
//                              [--concurrency 4] [--no-skip-existing] [--dry-run]
//   node cli/photos.mjs backfill-web [--space family|library] [--concurrency 4] [--dry-run]
//       Make the ~2048 px web version for photos that have none (uploaded before it existed): downloads each original
//       once, resizes it with sips, uploads web/<id>.jpg. Safe to re-run; photos that have one are skipped.
//
// Settings (each from the environment, else ~/.config/photos/credentials.env, which `npm run deploy` writes):
//   PHOTOS_URL                                your app, e.g. https://photos.example.com
//   PHOTOS_CLIENT_ID + PHOTOS_CLIENT_SECRET   the Cloudflare Access service token the deploy created
//   PHOTOS_JWT_FILE                           instead: a file holding an Access JWT (local dev, see scripts/local-access.mjs)
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const TYPES = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".heif": "image/heif",
	".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff", ".dng": "image/x-adobe-dng",
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
	".avi": "video/x-msvideo", ".3gp": "video/3gpp",
};

function usage(code = 2) {
	console.error(`usage: photos upload <file|folder>... [--space family|library] [--tag t]... [--tags a,b]
                     [--concurrency 4] [--no-skip-existing] [--dry-run]
       photos backfill-web [--space family|library] [--concurrency 4] [--dry-run]
upload: default space family. Folders are walked recursively; only photo and video files are uploaded.
backfill-web: makes the lightbox's web version for photos that have none; no --space = both spaces.`);
	process.exit(code);
}

function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	if (cmd !== "upload" && cmd !== "backfill-web") usage(cmd === "--help" || cmd === "-h" ? 0 : 2);
	const o = { cmd, paths: [], space: cmd === "upload" ? "family" : null, tags: [], concurrency: 4, skipExisting: true, dryRun: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const val = () => rest[++i] ?? usage();
		if (a === "--space") o.space = val();
		else if (a === "--tag") o.tags.push(val());
		else if (a === "--tags") o.tags.push(...val().split(","));
		else if (a === "--concurrency") o.concurrency = Math.max(1, Number(val()) || 4);
		else if (a === "--no-skip-existing") o.skipExisting = false;
		else if (a === "--dry-run") o.dryRun = true;
		else if (a.startsWith("--")) usage();
		else o.paths.push(a);
	}
	if (o.space !== null && !["family", "library"].includes(o.space)) usage();
	if (cmd === "upload" ? !o.paths.length : o.paths.length) usage();
	o.tags = o.tags.map((t) => t.trim()).filter(Boolean);
	return o;
}

const CREDENTIALS = process.env.PHOTOS_CREDENTIALS_FILE ?? join(homedir(), ".config/photos/credentials.env");

/** A setting: the environment, then ~/.config/photos/credentials.env. */
async function setting(name) {
	if (process.env[name]) return process.env[name];
	try {
		const m = (await readFile(CREDENTIALS, "utf8")).match(new RegExp(`^${name}=(.*)$`, "m"));
		if (m) return m[1].trim().replace(/^["']|["']$/g, "");
	} catch {}
	return undefined;
}

async function authHeaders() {
	if (process.env.PHOTOS_JWT_FILE) return { "cf-access-jwt-assertion": (await readFile(process.env.PHOTOS_JWT_FILE, "utf8")).trim() };
	const id = await setting("PHOTOS_CLIENT_ID");
	const secret = await setting("PHOTOS_CLIENT_SECRET");
	if (!id || !secret) {
		console.error(`No credentials: run \`npm run deploy\` (it saves them to ${CREDENTIALS}), or set PHOTOS_CLIENT_ID and PHOTOS_CLIENT_SECRET, or PHOTOS_JWT_FILE.`);
		process.exit(2);
	}
	return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

const BASE = ((await setting("PHOTOS_URL")) ?? "").replace(/\/+$/, "");
if (!BASE && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
	console.error(`No app URL: set PHOTOS_URL (e.g. https://photos.example.com), or run \`npm run deploy\`, which saves it to ${CREDENTIALS}.`);
	process.exit(2);
}
let AUTH = {};

async function api(path, { method = "GET", json, body, headers = {}, tries = 6 } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(`${BASE}${path}`, {
				method,
				headers: { ...AUTH, ...(json ? { "content-type": "application/json" } : {}), ...headers },
				body: json ? JSON.stringify(json) : body,
				redirect: "manual",
			});
			if (res.status >= 300 && res.status < 400) throw Object.assign(new Error(`redirected to ${res.headers.get("location")} — Access rejected the service token`), { fatal: true });
			const text = await res.text();
			let data;
			try { data = JSON.parse(text); } catch { data = text; }
			if (!res.ok) {
				const err = new Error(`${method} ${path}: ${res.status} ${data?.error ?? String(data).slice(0, 200)}`);
				err.status = res.status;
				err.fatal = res.status < 500 && res.status !== 429;
				throw err;
			}
			return data;
		} catch (err) {
			if (err.fatal || attempt >= tries) throw err;
			await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
		}
	}
}

async function walk(p, out = []) {
	const s = await stat(p);
	if (s.isDirectory()) {
		for (const e of (await readdir(p)).sort()) if (!e.startsWith(".")) await walk(join(p, e), out);
	} else if (TYPES[extname(p).toLowerCase()]) out.push(resolve(p));
	return out;
}

const isoOrNull = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

/**
 * The ~2048 px display JPEG (quality 82) the lightbox shows instead of the original. Made here at upload time, like the
 * thumbnail, not by Cloudflare Images (cheaper; README § Thumbnails and web versions). Never upscales. Best effort.
 * Budget 1 MB: a grainy shot over it is redone at 1600 px (in a 161-photo test set, 11 were 1.0–1.43 MB at 2048 and all were under 0.94 MB at 1600).
 */
const WEB_MAX = 2048;
const WEB_FALLBACK = 1600;
const WEB_BUDGET = 1024 * 1024;
async function makeWeb(file, out, width, height) {
	try {
		if (!width || !height) {
			// Unknown size (e.g. a browser-uploaded HEIC): read it, since `sips -Z` would upscale a small image.
			const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
			width = Number(stdout.match(/pixelWidth: (\d+)/)?.[1]) || 0;
			height = Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) || 0;
		}
		const long = Math.max(width, height);
		const make = (max) => run("sips", [...(long > max ? ["-Z", String(max)] : []), "-s", "format", "jpeg", "-s", "formatOptions", "82", file, "--out", out]);
		await make(WEB_MAX);
		if ((await stat(out)).size > WEB_BUDGET && long > WEB_FALLBACK) await make(WEB_FALLBACK);
		return out;
	} catch {
		return null; // not macOS or a format sips can't read: the lightbox shows the original
	}
}

/** Capture date, size, a 480px JPEG thumbnail and the web version, with what macOS (sips) and ffmpeg have. Best effort. */
async function inspect(file, tmp, { web: wantWeb = true } = {}) {
	const ct = TYPES[extname(file).toLowerCase()];
	const s = await stat(file);
	const meta = { content_type: ct, size: s.size, captured_at: s.mtime.toISOString(), captured_src: "mtime" };
	const thumb = join(tmp, `${basename(file)}.thumb.jpg`);
	let haveThumb = false;
	let web = null;
	if (ct.startsWith("video/")) {
		try {
			const { stdout } = await run("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
			const j = JSON.parse(stdout);
			const v = j.streams?.find((x) => x.codec_type === "video");
			meta.width = v?.width ?? null;
			meta.height = v?.height ?? null;
			// Phones record rotation as side data; report the displayed shape.
			const rot = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0));
			if (rot === 90 || rot === 270) [meta.width, meta.height] = [meta.height, meta.width];
			meta.duration = Number(j.format?.duration) || null;
			const tags = j.format?.tags ?? {};
			const when = isoOrNull(new Date(tags["com.apple.quicktime.creationdate"] ?? tags.creation_time ?? ""));
			if (when) Object.assign(meta, { captured_at: when, captured_src: "video" });
			const at = String(Math.min(1, (meta.duration ?? 2) / 2));
			await run("ffmpeg", ["-v", "error", "-y", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", thumb]);
			haveThumb = true;
		} catch { /* no ffmpeg / unreadable: upload without a thumbnail */ }
	} else {
		try {
			const { stdout } = await run("sips", ["-g", "creation", "-g", "pixelWidth", "-g", "pixelHeight", file]);
			const c = stdout.match(/creation: (\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
			if (c) Object.assign(meta, { captured_at: new Date(+c[1], +c[2] - 1, +c[3], +c[4], +c[5], +c[6]).toISOString(), captured_src: "exif" });
			meta.width = Number(stdout.match(/pixelWidth: (\d+)/)?.[1]) || null;
			meta.height = Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) || null;
			await run("sips", ["-Z", "480", "-s", "format", "jpeg", "-s", "formatOptions", "75", file, "--out", thumb]);
			haveThumb = true;
		} catch { /* not macOS or unsupported format */ }
		// No web version for GIFs: the lightbox shows the original so an animation keeps playing.
		if (haveThumb && wantWeb && ct !== "image/gif") web = await makeWeb(file, join(tmp, `${basename(file)}.web.jpg`), meta.width, meta.height);
	}
	return { meta, thumb: haveThumb ? thumb : null, web };
}

// Resume state: finished parts per in-progress upload, so a dropped connection never costs the parts already sent.
// R2 drops an unfinished multipart upload after 7 days; the Worker then answers 410 and the CLI starts the file again.
const STATE = join(homedir(), ".config/photos/uploads.json");
async function loadState() {
	try {
		return JSON.parse(await readFile(STATE, "utf8"));
	} catch {
		return {};
	}
}
let saving = Promise.resolve();
function saveState(state) {
	const text = JSON.stringify(state);
	saving = saving.then(async () => {
		await mkdir(dirname(STATE), { recursive: true });
		await writeFile(`${STATE}.tmp`, text);
		await rename(`${STATE}.tmp`, STATE);
	});
	return saving;
}

/** The saved upload for this file, if the server still has it in progress. Only a 404 means "start fresh". */
async function resumable(prev) {
	if (!prev) return null;
	try {
		const item = await api(`/api/items/${prev.id}`); // network errors and 5xx retry; they never mean "start over"
		return item?.status === "uploading" ? prev : null;
	} catch (err) {
		if (err.status === 404) return null;
		throw err;
	}
}

/** Send every missing part and complete. Returns the item id. A 410 means R2 dropped the upload. */
async function transfer(file, o, meta, state, resumeKey, label, filename) {
	let start = null;
	let entry = await resumable(state[resumeKey]);
	if (entry) {
		start = { id: entry.id, part_size: entry.part_size, parts: Math.ceil(meta.size / entry.part_size) };
		console.log(`${label} resume ${filename}: ${entry.parts.length}/${start.parts} parts already uploaded`);
	} else {
		start = await api("/api/uploads", { method: "POST", json: { filename, space: o.space, tags: o.tags, ...meta } });
		entry = state[resumeKey] = { id: start.id, part_size: start.part_size, parts: [] };
		await saveState(state);
	}
	const parts = entry.parts;
	const fh = await open(file, "r");
	const have = new Set(parts.map((p) => p.part_number));
	const todo = Array.from({ length: start.parts }, (_, i) => i + 1).filter((n) => !have.has(n));
	let done = parts.length * start.part_size;
	let stopped = false; // once one part fails, the other workers stop instead of writing state after we move on
	const progress = () => process.stdout.write(`\r${label} upload ${filename} ${Math.min(100, Math.floor((done / meta.size) * 100))}% of ${fmt(meta.size)}   `);
	try {
		const worker = async () => {
			while (todo.length && !stopped) {
				const n = todo.shift();
				const offset = (n - 1) * start.part_size;
				const len = Math.min(start.part_size, meta.size - offset);
				const buf = Buffer.allocUnsafe(len);
				const { bytesRead } = await fh.read(buf, 0, len, offset);
				if (bytesRead !== len) throw new Error(`short read on part ${n}`);
				const part = await api(`/api/uploads/${start.id}/parts/${n}`, {
					method: "PUT",
					body: buf,
					headers: { "content-type": "application/octet-stream" },
				});
				if (stopped) return;
				parts.push(part);
				await saveState(state);
				done += len;
				progress();
			}
		};
		progress();
		await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, () => worker().catch((e) => { stopped = true; throw e; })));
		parts.sort((a, b) => a.part_number - b.part_number);
		await api(`/api/uploads/${start.id}/complete`, { method: "POST", json: { parts } });
		delete state[resumeKey];
		await saveState(state);
	} catch (err) {
		stopped = true;
		process.stdout.write("\n");
		if (err.status === 409) err.message += " (the server discarded this upload; re-run the same command to upload the file again)";
		else if (err.status !== 410) err.message += ` (${parts.length}/${start.parts} parts are saved; re-run the same command to resume)`;
		throw err;
	} finally {
		await fh.close();
	}
	return start.id;
}

const fmt = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

async function uploadOne(file, o, tmp, label) {
	const filename = basename(file);
	if (o.skipExisting) {
		// Before inspect(): a skipped file costs one stat, not two sips passes.
		const { item } = await api(`/api/exists?filename=${encodeURIComponent(filename)}&size=${(await stat(file)).size}`);
		if (item?.status === "ready") return console.log(`${label} skip   ${filename} (already uploaded, ${item.space})`);
	}
	const { meta, thumb, web } = await inspect(file, tmp, { web: !o.dryRun });
	if (o.dryRun) return console.log(`${label} would  ${filename} ${fmt(meta.size)} → ${o.space} [${o.tags.join(", ")}] ${meta.captured_at} (${meta.captured_src})`);
	const t0 = Date.now();
	const s = await stat(file);
	const resumeKey = `${BASE}|${file}|${meta.size}|${s.mtimeMs}`;
	const state = await loadState();
	let id;
	try {
		id = await transfer(file, o, meta, state, resumeKey, label, filename);
	} catch (err) {
		if (err.status !== 410) throw err;
		// R2 dropped the multipart upload (7-day expiry): clear the dead row and the saved parts, then start clean.
		const dead = state[resumeKey]?.id;
		console.log(`\n${label} restart ${filename}: the saved upload expired on R2; starting this file again`);
		// Best effort: a failed DELETE must not wedge every re-run on the same dead upload.
		if (dead) await api(`/api/uploads/${dead}`, { method: "DELETE" }).catch((e) => { if (e.status !== 404) console.warn(`  could not clear the expired upload ${dead}: ${e.message}`); });
		delete state[resumeKey];
		await saveState(state);
		id = await transfer(file, o, meta, state, resumeKey, label, filename);
	}
	if (thumb) {
		const jpg = await readFile(thumb);
		await api(`/api/items/${id}/thumb`, { method: "PUT", body: jpg, headers: { "content-type": "image/jpeg" } }).catch((e) => console.warn(`\n  thumbnail failed: ${e.message}`));
	}
	if (web) {
		const jpg = await readFile(web);
		await api(`/api/items/${id}/web`, { method: "PUT", body: jpg, headers: { "content-type": "image/jpeg" } }).catch((e) => console.warn(`\n  web version failed: ${e.message}`));
	}
	const secs = (Date.now() - t0) / 1000;
	process.stdout.write(`\r${label} done   ${filename} ${fmt(meta.size)} in ${secs.toFixed(0)}s (${(meta.size / 1e6 / secs).toFixed(1)} MB/s) → ${o.space} id=${id}\n`);
}

/** Every ready photo with no web version, in the given space (or both), archived included. */
async function photosWithoutWeb(space) {
	const out = [];
	for (const sp of space ? [space] : ["family", "library"]) {
		let cursor = null;
		do {
			const q = new URLSearchParams({ space: sp, kind: "photo", archived: "all", limit: "500" });
			if (cursor) q.set("cursor", cursor);
			const page = await api(`/api/items?${q}`);
			out.push(...page.items.filter((it) => !it.has_web));
			cursor = page.next;
		} while (cursor);
	}
	return out.filter((it) => it.content_type !== "image/gif"); // GIFs keep the original (animation)
}

/** Download the original once (to a temp file), make the web version, upload it, delete the temp files. */
async function backfillOne(it, tmp, label) {
	const res = await fetch(`${BASE}/media/${it.id}`, { headers: AUTH, redirect: "manual" });
	if (!res.ok) throw new Error(`GET /media/${it.id}: ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length !== it.size) throw new Error(`downloaded ${buf.length} bytes, expected ${it.size}`);
	const ext = extname(it.filename).toLowerCase() || ".jpg";
	const orig = join(tmp, `${it.id}${ext}`);
	const out = join(tmp, `${it.id}.web.jpg`);
	await writeFile(orig, buf);
	try {
		if (!(await makeWeb(orig, out, it.width, it.height))) throw new Error("sips could not make a web version");
		const jpg = await readFile(out);
		await api(`/api/items/${it.id}/web`, { method: "PUT", body: jpg, headers: { "content-type": "image/jpeg" } });
		console.log(`${label} web    ${it.filename} ${fmt(it.size)} → ${fmt(jpg.length)} id=${it.id}`);
	} finally {
		await rm(orig, { force: true });
		await rm(out, { force: true });
	}
}

async function backfillWeb(o) {
	const todo = await photosWithoutWeb(o.space);
	console.log(`${todo.length} photo(s) without a web version → ${BASE}${o.space ? ` space=${o.space}` : ""}`);
	if (o.dryRun) {
		for (const it of todo) console.log(`  would  ${it.filename} ${fmt(it.size)} (${it.space}) id=${it.id}`);
		return;
	}
	const tmp = await mkdtemp(join(tmpdir(), "photos-web-"));
	let failed = 0, n = 0;
	const queue = todo.map((it) => ({ it, label: `[${++n}/${todo.length}]` }));
	try {
		await Promise.all(Array.from({ length: Math.min(o.concurrency, queue.length) }, async () => {
			while (queue.length) {
				const { it, label } = queue.shift();
				// One bad photo never stops the run: report it, carry on, exit non-zero at the end.
				await backfillOne(it, tmp, label).catch((err) => { failed++; console.error(`${label} FAILED ${it.filename}: ${err.message}`); });
			}
		}));
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
	if (failed) {
		console.error(`${failed} photo(s) failed; re-run the same command to retry (photos that have a web version are skipped).`);
		process.exit(1);
	}
}

async function main() {
	const o = parseArgs(process.argv.slice(2));
	AUTH = await authHeaders();
	if (o.cmd === "backfill-web") return backfillWeb(o);
	const files = [];
	for (const p of o.paths) await walk(p, files);
	if (!files.length) {
		console.error("No photo or video files found.");
		process.exit(1);
	}
	console.log(`${files.length} file(s) → ${BASE} space=${o.space}${o.tags.length ? ` tags=${o.tags.join(",")}` : ""}`);
	const tmp = await mkdtemp(join(tmpdir(), "photos-"));
	let failed = 0;
	try {
		for (const [i, f] of files.entries()) {
			const label = `[${i + 1}/${files.length}]`;
			try {
				await uploadOne(f, o, tmp, label);
			} catch (err) {
				failed++;
				console.error(`${label} FAILED ${basename(f)}: ${err.message}`);
				if (err.message.includes("Access rejected")) break;
			}
		}
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
	if (failed) {
		console.error(`${failed} file(s) failed; re-run the same command to retry (finished files are skipped).`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
