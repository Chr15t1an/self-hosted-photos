import { Hono } from "hono";
import { accessVerifier, authorize, tokenFrom, type Caller } from "./auth";

export interface Env {
	BUCKET: R2Bucket;
	DB: D1Database;
	ASSETS: Fetcher;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD?: string;
	OWNER_EMAILS?: string;
	ACCESS_SERVICE_CLIENT_IDS?: string;
}

type App = { Bindings: Env; Variables: { caller: Caller } };

const SPACES = ["family", "library"] as const;
type Space = (typeof SPACES)[number];
/** Each multipart part goes through the Worker, so it must stay under the 100 MB request-body cap. */
const PART_SIZE = 50 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;
/** The display version (~2048 px JPEG) is ~0.5–1.5 MB; anything near the cap is not a web version. */
const MAX_WEB = 8 * 1024 * 1024;

const app = new Hono<App>();

// ── Auth: every request (pages, scripts, API, media) needs a valid Access JWT for an owner or the CLI's token. ──
app.use("*", async (c, next) => {
	const env = c.env;
	if (!env.ACCESS_AUD) return c.text("ACCESS_AUD is not set; refusing all requests", 401);
	const token = tokenFrom(c.req.raw);
	if (!token) return c.text("Sign in through Cloudflare Access", 401);
	try {
		const identity = await accessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })(token);
		const caller = authorize(identity, env);
		if (!caller) return c.text(`${identity.id} is not allowed`, 403);
		c.set("caller", caller);
	} catch {
		return c.text("Invalid Access token", 401);
	}
	await next();
});

const who = (c: { get: (k: "caller") => Caller }) => {
	const caller = c.get("caller");
	return caller.kind === "person" ? caller.email : `service:${caller.clientId}`;
};

const isSpace = (v: unknown): v is Space => typeof v === "string" && (SPACES as readonly string[]).includes(v);
const normTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
/**
 * A type a browser could run script from (SVG, HTML, XML, JS). Such a file is never stored as a photo, and nothing is
 * served inline on this origin (where it would hold the Access cookie) unless it is a plain image or video type.
 */
const scriptable = (ct: string) => /svg|html|xml|javascript|ecmascript/i.test(ct);
const SCRIPTABLE_NAME = /\.(svgz?|x?html?|xht|xml|js|mjs)$/i;
const inlineSafe = (ct: string | undefined) => !!ct && /^(image|video)\/[a-z0-9.+-]+$/i.test(ct) && !scriptable(ct);
const EXT_TYPES: Record<string, string> = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".heif": "image/heif",
	".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff", ".dng": "image/x-adobe-dng",
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
	".avi": "video/x-msvideo", ".3gp": "video/3gpp",
};
/** The type to store, and the kind, or null when it isn't a photo or video (or could run script). */
const classify = (declared: string, filename: string): { ct: string; kind: "photo" | "video" } | null => {
	if (scriptable(declared) || SCRIPTABLE_NAME.test(filename)) return null;
	const ext = (filename.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? "").toLowerCase();
	const ct = inlineSafe(declared) ? declared : EXT_TYPES[ext]; // browsers send "" or odd types for some files
	if (!ct) return null;
	return { ct, kind: ct.startsWith("video/") ? "video" : "photo" };
};

interface ItemRow {
	id: string;
	key: string;
	space: Space;
	kind: "photo" | "video";
	filename: string;
	content_type: string;
	size: number;
	captured_at: string | null;
	captured_src: string | null;
	width: number | null;
	height: number | null;
	duration: number | null;
	thumb_key: string | null;
	web_key: string | null;
	social_ok: number;
	archived: number;
	status: string;
	upload_id: string | null;
	uploaded_by: string | null;
	uploaded_at: string;
	tags?: string | null;
}

function present(r: ItemRow) {
	return {
		id: r.id,
		space: r.space,
		kind: r.kind,
		filename: r.filename,
		content_type: r.content_type,
		size: r.size,
		captured_at: r.captured_at,
		captured_src: r.captured_src,
		width: r.width,
		height: r.height,
		duration: r.duration,
		has_thumb: !!r.thumb_key,
		has_web: !!r.web_key,
		social_ok: !!r.social_ok,
		archived: !!r.archived,
		status: r.status,
		uploaded_by: r.uploaded_by,
		uploaded_at: r.uploaded_at,
		tags: r.tags ? r.tags.split("\u001f").sort() : [],
	};
}

const SELECT_ITEM = `SELECT i.*, (SELECT group_concat(tag, char(31)) FROM item_tags t WHERE t.item_id = i.id) AS tags FROM items i`;

async function getItem(env: Env, id: string): Promise<ItemRow | null> {
	return env.DB.prepare(`${SELECT_ITEM} WHERE i.id = ?`).bind(id).first<ItemRow>();
}

// ── Browse ──
app.get("/api/items", async (c) => {
	const q = c.req.query();
	const space = q.space;
	if (!isSpace(space)) return c.json({ error: "space must be family or library" }, 400);
	const where = ["i.space = ?", "i.status = 'ready'"];
	const args: unknown[] = [space];
	if (q.archived === "1") where.push("i.archived = 1");
	else if (q.archived !== "all") where.push("i.archived = 0");
	if (q.social === "1") where.push("i.social_ok = 1");
	if (q.social === "0") where.push("i.social_ok = 0");
	if (q.kind === "photo" || q.kind === "video") {
		where.push("i.kind = ?");
		args.push(q.kind);
	}
	if (q.tag) {
		where.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)");
		args.push(normTag(q.tag));
	}
	// Cursor = "<sort key>|<id>" of the last row seen; sort is newest capture first, then newest upload.
	const limit = Math.min(Number(q.limit) || 120, 500);
	if (q.cursor) {
		const [sk, cid] = q.cursor.split("|");
		where.push("(COALESCE(i.captured_at, i.uploaded_at) < ? OR (COALESCE(i.captured_at, i.uploaded_at) = ? AND i.id < ?))");
		args.push(sk, sk, cid);
	}
	const rows = await c.env.DB.prepare(
		`${SELECT_ITEM} WHERE ${where.join(" AND ")} ORDER BY COALESCE(i.captured_at, i.uploaded_at) DESC, i.id DESC LIMIT ?`,
	)
		.bind(...args, limit + 1)
		.all<ItemRow>();
	const list = rows.results.slice(0, limit);
	const last = list[list.length - 1];
	const next = rows.results.length > limit && last ? `${last.captured_at ?? last.uploaded_at}|${last.id}` : null;
	return c.json({ items: list.map(present), next });
});

app.get("/api/tags", async (c) => {
	const space = c.req.query("space");
	const rows = isSpace(space)
		? await c.env.DB.prepare(
				`SELECT t.tag, count(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.space = ? AND i.status = 'ready' GROUP BY t.tag ORDER BY t.tag`,
			)
				.bind(space)
				.all()
		: await c.env.DB.prepare(`SELECT tag, count(*) AS n FROM item_tags GROUP BY tag ORDER BY tag`).all();
	return c.json({ tags: rows.results });
});

app.get("/api/items/:id", async (c) => {
	const r = await getItem(c.env, c.req.param("id"));
	return r ? c.json(present(r)) : c.json({ error: "not found" }, 404);
});

/** The CLI asks before uploading so a re-run over the same folder skips what is already there. */
app.get("/api/exists", async (c) => {
	const { filename, size } = c.req.query();
	// Only a finished upload counts; an orphaned 'uploading' row must not hide (or stand in for) the ready one.
	const r = await c.env.DB.prepare(`SELECT id, space, status FROM items WHERE filename = ? AND size = ? AND status = 'ready' LIMIT 1`)
		.bind(filename ?? "", Number(size))
		.first();
	return c.json({ item: r ?? null });
});

// ── Edit: social_ok, archived, space, captured_at ──
app.patch("/api/items/:id", async (c) => {
	const id = c.req.param("id");
	const item = await getItem(c.env, id);
	if (!item) return c.json({ error: "not found" }, 404);
	const body = await c.req.json<Record<string, unknown>>();
	const space = body.space === undefined ? item.space : body.space;
	if (!isSpace(space)) return c.json({ error: "space must be family or library" }, 400);
	let social = body.social_ok === undefined ? !!item.social_ok : !!body.social_ok;
	if (space === "family") {
		if (body.social_ok === true) return c.json({ error: "Family items can't be in the social pool. Move it to Library first." }, 400);
		social = false; // moving to family always takes an item out of the social pool
	}
	const archived = body.archived === undefined ? !!item.archived : !!body.archived;
	const captured = typeof body.captured_at === "string" ? body.captured_at : item.captured_at;
	const capturedSrc = typeof body.captured_at === "string" ? "manual" : item.captured_src;
	await c.env.DB.prepare(`UPDATE items SET space = ?, social_ok = ?, archived = ?, captured_at = ?, captured_src = ? WHERE id = ?`)
		.bind(space, social ? 1 : 0, archived ? 1 : 0, captured, capturedSrc, id)
		.run();
	return c.json(present((await getItem(c.env, id))!));
});

app.post("/api/items/:id/tags", async (c) => {
	const id = c.req.param("id");
	const { tags } = await c.req.json<{ tags: string[] | string }>();
	const list = (Array.isArray(tags) ? tags : [tags]).map(normTag).filter(Boolean);
	if (!list.length) return c.json({ error: "no tags" }, 400);
	if (!(await getItem(c.env, id))) return c.json({ error: "not found" }, 404);
	await c.env.DB.batch(list.map((t) => c.env.DB.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)`).bind(id, t)));
	return c.json(present((await getItem(c.env, id))!));
});

app.delete("/api/items/:id/tags/:tag", async (c) => {
	const id = c.req.param("id");
	await c.env.DB.prepare(`DELETE FROM item_tags WHERE item_id = ? AND tag = ?`).bind(id, normTag(c.req.param("tag"))).run();
	const r = await getItem(c.env, id);
	return r ? c.json(present(r)) : c.json({ error: "not found" }, 404);
});

/** Permanent delete: the original, thumbnail and web version leave R2, the row and its tags leave D1. No undo. */
app.delete("/api/items/:id", async (c) => {
	const id = c.req.param("id");
	const r = await c.env.DB.prepare(`SELECT key, thumb_key, web_key, status, upload_id FROM items WHERE id = ?`)
		.bind(id)
		.first<{ key: string; thumb_key: string | null; web_key: string | null; status: string; upload_id: string | null }>();
	if (!r) return c.json({ error: "not found" }, 404);
	if (r.status === "uploading" && r.upload_id) {
		try {
			await c.env.BUCKET.resumeMultipartUpload(r.key, r.upload_id).abort();
		} catch (err) {
			if (!isGoneUpload(err)) throw err; // a real failure: keep the row so a retry can abort it
		}
	}
	await c.env.BUCKET.delete([r.key, ...[r.thumb_key, r.web_key].filter((k): k is string => !!k)]);
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM item_tags WHERE item_id = ?`).bind(id),
		c.env.DB.prepare(`DELETE FROM group_items WHERE item_id = ?`).bind(id),
		c.env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
	]);
	return c.json({ deleted: id });
});

// ── Groups: a named, ordered set of items picked by hand, to share from a phone. Private; no public links. ──
const MAX_GROUP = 500;
const groupName = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 120) : "");
const idList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length <= 64))] : []);

async function groupSummary(env: Env, id?: string) {
	const rows = await env.DB.prepare(
		`SELECT g.id, g.name, g.created_by, g.created_at, g.updated_at,
		   (SELECT count(*) FROM group_items gi JOIN items i ON i.id = gi.item_id WHERE gi.group_id = g.id AND i.status = 'ready') AS n,
		   (SELECT gi.item_id FROM group_items gi JOIN items i ON i.id = gi.item_id
		      WHERE gi.group_id = g.id AND i.status = 'ready' AND i.thumb_key IS NOT NULL ORDER BY gi.position LIMIT 1) AS cover
		 FROM groups g ${id ? "WHERE g.id = ?" : ""} ORDER BY g.updated_at DESC`,
	)
		.bind(...(id ? [id] : []))
		.all<{ id: string; name: string; n: number; cover: string | null }>();
	return rows.results;
}

/** Appends items that exist and are ready, in the order given, skipping ones already in the group. Returns how many were added. */
async function addToGroup(env: Env, groupId: string, ids: string[]) {
	if (!ids.length) return 0;
	const found = new Set<string>();
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90); // D1 caps bound parameters per query at 100
		const r = await env.DB.prepare(`SELECT id FROM items WHERE status = 'ready' AND id IN (${chunk.map(() => "?").join(",")})`)
			.bind(...chunk)
			.all<{ id: string }>();
		r.results.forEach((x) => found.add(x.id));
	}
	const have = await env.DB.prepare(`SELECT item_id FROM group_items WHERE group_id = ?`).bind(groupId).all<{ item_id: string }>();
	const already = new Set(have.results.map((x) => x.item_id));
	const add = ids.filter((id) => found.has(id) && !already.has(id));
	if (already.size + add.length > MAX_GROUP) throw new HttpError(400, `a group holds at most ${MAX_GROUP} items`);
	// One statement for the whole list (json_each keeps the order in `key`), so a big add stays one query.
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO group_items (group_id, item_id, position)
			 SELECT ?1, j.value, (SELECT COALESCE(MAX(position), 0) FROM group_items WHERE group_id = ?1) + j.key + 1 FROM json_each(?2) j`,
		).bind(groupId, JSON.stringify(add)),
		env.DB.prepare(`UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(groupId),
	]);
	return add.length;
}

class HttpError extends Error {
	constructor(readonly status: 400 | 404, message: string) {
		super(message);
	}
}
app.onError((err, c) => {
	if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
	if (err instanceof SyntaxError) return c.json({ error: "body must be JSON" }, 400);
	console.error(err);
	return c.json({ error: "server error" }, 500);
});

app.get("/api/groups", async (c) => c.json({ groups: await groupSummary(c.env) }));

app.post("/api/groups", async (c) => {
	const b = await c.req.json<{ name?: unknown; item_ids?: unknown }>();
	const name = groupName(b.name);
	if (!name) return c.json({ error: "a group needs a name" }, 400);
	const ids = idList(b.item_ids);
	if (ids.length > MAX_GROUP) return c.json({ error: `a group holds at most ${MAX_GROUP} items` }, 400);
	const id = crypto.randomUUID();
	await c.env.DB.prepare(`INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)`).bind(id, name, who(c)).run();
	let added: number;
	try {
		added = await addToGroup(c.env, id, ids);
	} catch (err) {
		await c.env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(id).run(); // no empty group left behind
		throw err;
	}
	return c.json({ group: (await groupSummary(c.env, id))[0], added });
});

app.get("/api/groups/:id", async (c) => {
	const id = c.req.param("id");
	const [g] = await groupSummary(c.env, id);
	if (!g) return c.json({ error: "not found" }, 404);
	const rows = await c.env.DB.prepare(
		`${SELECT_ITEM} JOIN group_items gi ON gi.item_id = i.id WHERE gi.group_id = ? AND i.status = 'ready' ORDER BY gi.position`,
	)
		.bind(id)
		.all<ItemRow>();
	return c.json({ group: g, items: rows.results.map(present) });
});

app.patch("/api/groups/:id", async (c) => {
	const id = c.req.param("id");
	const name = groupName((await c.req.json<{ name?: unknown }>()).name);
	if (!name) return c.json({ error: "a group needs a name" }, 400);
	const r = await c.env.DB.prepare(`UPDATE groups SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(name, id).run();
	if (!r.meta.changes) return c.json({ error: "not found" }, 404);
	return c.json({ group: (await groupSummary(c.env, id))[0] });
});

/** Deletes the group only. Its photos stay where they are. */
app.delete("/api/groups/:id", async (c) => {
	const id = c.req.param("id");
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM group_items WHERE group_id = ?`).bind(id),
		c.env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(id),
	]);
	return c.json({ deleted: id });
});

app.post("/api/groups/:id/items", async (c) => {
	const id = c.req.param("id");
	if (!(await groupSummary(c.env, id)).length) return c.json({ error: "not found" }, 404);
	const added = await addToGroup(c.env, id, idList((await c.req.json<{ item_ids?: unknown }>()).item_ids));
	return c.json({ group: (await groupSummary(c.env, id))[0], added });
});

/** Takes items out of the group (body: item_ids). The photos themselves are untouched. */
app.post("/api/groups/:id/remove", async (c) => {
	const id = c.req.param("id");
	const ids = idList((await c.req.json<{ item_ids?: unknown }>()).item_ids).slice(0, MAX_GROUP);
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM group_items WHERE group_id = ? AND item_id IN (SELECT value FROM json_each(?))`).bind(id, JSON.stringify(ids)),
		c.env.DB.prepare(`UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(id),
	]);
	const [g] = await groupSummary(c.env, id);
	return g ? c.json({ group: g }) : c.json({ error: "not found" }, 404);
});

// ── Upload: one path for the web and the CLI. R2 multipart; each part ≤ PART_SIZE goes through the Worker. ──
interface StartBody {
	filename: string;
	size: number;
	content_type?: string;
	space: Space;
	tags?: string[];
	captured_at?: string | null;
	captured_src?: string | null;
	width?: number | null;
	height?: number | null;
	duration?: number | null;
}

app.post("/api/uploads", async (c) => {
	const b = await c.req.json<StartBody>();
	if (!isSpace(b.space)) return c.json({ error: "space must be family or library" }, 400);
	if (!b.filename || !(b.size > 0)) return c.json({ error: "filename and size are required" }, 400);
	const declared = (typeof b.content_type === "string" ? b.content_type : "").trim().toLowerCase();
	const cls = classify(declared, b.filename);
	if (!cls) return c.json({ error: `not a photo or video: ${b.filename} (${declared || "no type"})` }, 400);
	const { ct, kind } = cls;
	const id = crypto.randomUUID();
	const ext = (b.filename.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? "").toLowerCase();
	const day = (b.captured_at ?? new Date().toISOString()).slice(0, 7); // originals/<space>/<YYYY-MM>/<id>.<ext>
	const key = `originals/${b.space}/${day}/${id}${ext}`;
	const mpu = await c.env.BUCKET.createMultipartUpload(key, {
		httpMetadata: { contentType: ct },
		customMetadata: { filename: b.filename, item: id },
	});
	const tags = (b.tags ?? []).map(normTag).filter(Boolean);
	await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT INTO items (id, key, space, kind, filename, content_type, size, captured_at, captured_src, width, height, duration, status, upload_id, uploaded_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
		).bind(
			id,
			key,
			b.space,
			kind,
			b.filename,
			ct,
			b.size,
			b.captured_at ?? null,
			b.captured_src ?? null,
			b.width ?? null,
			b.height ?? null,
			b.duration ?? null,
			mpu.uploadId,
			who(c),
		),
		...tags.map((t) => c.env.DB.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)`).bind(id, t)),
	]);
	return c.json({ id, part_size: PART_SIZE, parts: Math.ceil(b.size / PART_SIZE) });
});

/** R2 drops an unfinished multipart upload after 7 days; after that the upload id is unknown to it. */
const GONE = "upload expired: R2 no longer has this multipart upload; start the file again";
const isGoneUpload = (err: unknown) => /NoSuchUpload|\b10024\b/.test(String((err as Error)?.message ?? err)); // R2 code 10024 only

async function uploadingItem(env: Env, id: string) {
	const r = await env.DB.prepare(`SELECT id, key, upload_id, status, size FROM items WHERE id = ?`).bind(id).first<ItemRow>();
	if (!r || r.status !== "uploading" || !r.upload_id) return null;
	return { row: r, mpu: env.BUCKET.resumeMultipartUpload(r.key, r.upload_id) };
}

app.put("/api/uploads/:id/parts/:n", async (c) => {
	const u = await uploadingItem(c.env, c.req.param("id"));
	if (!u) return c.json({ error: "no upload in progress for this item" }, 404);
	const n = Number(c.req.param("n"));
	if (!(n >= 1 && n <= 10000)) return c.json({ error: "part number 1..10000" }, 400);
	const len = Number(c.req.header("content-length"));
	if (!(len > 0) || len > PART_SIZE) return c.json({ error: `part must have a content-length of 1..${PART_SIZE}` }, 400);
	try {
		const part = await u.mpu.uploadPart(n, c.req.raw.body!);
		return c.json({ part_number: part.partNumber, etag: part.etag });
	} catch (err) {
		if (isGoneUpload(err)) return c.json({ error: GONE }, 410);
		throw err;
	}
});

app.post("/api/uploads/:id/complete", async (c) => {
	const id = c.req.param("id");
	const u = await uploadingItem(c.env, id);
	if (!u) return c.json({ error: "no upload in progress for this item" }, 404);
	const { parts } = await c.req.json<{ parts?: { part_number: number; etag: string }[] }>();
	// Every part, exactly once: 1..ceil(size / PART_SIZE). A prefix of the parts would complete as a truncated file.
	const want = Math.ceil(u.row.size / PART_SIZE);
	const nums = Array.isArray(parts) ? parts.map((p) => p?.part_number) : [];
	const exact = nums.length === want && [...nums].sort((a, b) => a - b).every((n, i) => n === i + 1) && parts!.every((p) => typeof p.etag === "string");
	if (!exact) return c.json({ error: `expected parts 1..${want} each exactly once with an etag, got ${nums.length}` }, 400);
	let obj: { size: number };
	try {
		obj = await u.mpu.complete(parts!.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
	} catch (err) {
		if (!isGoneUpload(err)) throw err;
		// Already completed by an earlier call whose D1 update never landed? Then the object is there.
		const head = await c.env.BUCKET.head(u.row.key);
		if (!head) return c.json({ error: GONE }, 410);
		obj = head;
	}
	if (obj.size !== u.row.size) {
		// Never mark a file ready that isn't the file that was declared. Drop the bad object and the row.
		await c.env.BUCKET.delete(u.row.key);
		await c.env.DB.batch([
			c.env.DB.prepare(`DELETE FROM item_tags WHERE item_id = ?`).bind(id),
			c.env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
		]);
		return c.json({ error: `stored ${obj.size} bytes but ${u.row.size} were declared; upload discarded` }, 409);
	}
	await c.env.DB.prepare(`UPDATE items SET status = 'ready', upload_id = NULL WHERE id = ?`).bind(id).run();
	return c.json(present((await getItem(c.env, id))!));
});

app.delete("/api/uploads/:id", async (c) => {
	const id = c.req.param("id");
	const u = await uploadingItem(c.env, id);
	if (!u) return c.json({ error: "no upload in progress for this item" }, 404);
	try {
		await u.mpu.abort();
	} catch (err) {
		if (!isGoneUpload(err)) throw err; // R2 already dropped it (7-day expiry): just clear the row
	}
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM item_tags WHERE item_id = ?`).bind(id),
		c.env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
	]);
	return c.json({ aborted: id });
});

/**
 * Derived JPEGs, made by the uploader (browser canvas or the CLI's sips/ffmpeg), never by the Worker or Cloudflare Images:
 * the 480 px thumbnail (grid) and the ~2048 px web version (lightbox). See README § Thumbnails and web versions.
 */
const derived = (kind: "thumb" | "web", prefix: string, column: "thumb_key" | "web_key", max: number) =>
	app.put(`/api/items/:id/${kind}`, async (c) => {
		const id = c.req.param("id");
		const r = await c.env.DB.prepare(`SELECT kind FROM items WHERE id = ?`).bind(id).first<{ kind: string }>();
		if (!r) return c.json({ error: "not found" }, 404);
		if (kind === "web" && r.kind !== "photo") return c.json({ error: "web versions are for photos only" }, 400);
		const len = Number(c.req.header("content-length"));
		if (!(len > 0) || len > max) return c.json({ error: `${kind} image must be 1 byte..${max / 1024 / 1024} MB` }, 400);
		const key = `${prefix}/${id}.jpg`;
		await c.env.BUCKET.put(key, c.req.raw.body!, { httpMetadata: { contentType: "image/jpeg" } });
		await c.env.DB.prepare(`UPDATE items SET ${column} = ? WHERE id = ?`).bind(key, id).run();
		return c.json({ ok: true });
	});
derived("thumb", "thumbs", "thumb_key", MAX_THUMB);
derived("web", "web", "web_key", MAX_WEB);

// ── Media: originals with HTTP range support (video seeking), thumbnails. ──
async function serveObject(c: { req: { raw: Request }; env: Env }, key: string, filename?: string): Promise<Response> {
	const req = c.req.raw;
	const obj = await c.env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
	if (!obj) return new Response("not found", { status: 404 });
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("etag", obj.httpEtag);
	headers.set("accept-ranges", "bytes");
	headers.set("cache-control", "private, max-age=86400");
	// The stored type came from the uploader. Never let it be sniffed or run script on this origin.
	headers.set("x-content-type-options", "nosniff");
	headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
	const safe = inlineSafe(obj.httpMetadata?.contentType);
	if (!safe) headers.set("content-type", "application/octet-stream");
	const disp = safe ? "inline" : "attachment";
	if (filename) headers.set("content-disposition", `${disp}; filename*=UTF-8''${encodeURIComponent(filename)}`);
	else if (!safe) headers.set("content-disposition", "attachment");
	if (!("body" in obj)) return new Response(null, { status: 304, headers }); // onlyIf precondition failed
	const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
	if (range && req.headers.has("range")) {
		const offset = range.suffix !== undefined ? obj.size - range.suffix : (range.offset ?? 0);
		const length = range.suffix !== undefined ? range.suffix : (range.length ?? obj.size - offset);
		headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
		headers.set("content-length", String(length));
		return new Response(obj.body, { status: 206, headers });
	}
	headers.set("content-length", String(obj.size));
	return new Response(obj.body, { status: 200, headers });
}

app.get("/media/:id", async (c) => {
	const r = await c.env.DB.prepare(`SELECT key, filename FROM items WHERE id = ? AND status = 'ready'`)
		.bind(c.req.param("id"))
		.first<{ key: string; filename: string }>();
	if (!r) return c.text("not found", 404);
	const res = await serveObject(c, r.key, r.filename);
	if (c.req.query("download") === "1") res.headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
	return res;
});

app.get("/thumb/:id", async (c) => {
	const r = await c.env.DB.prepare(`SELECT thumb_key FROM items WHERE id = ?`).bind(c.req.param("id")).first<{ thumb_key: string | null }>();
	if (!r?.thumb_key) return c.text("no thumbnail", 404);
	return serveObject(c, r.thumb_key);
});

app.get("/web/:id", async (c) => {
	const r = await c.env.DB.prepare(`SELECT web_key FROM items WHERE id = ?`).bind(c.req.param("id")).first<{ web_key: string | null }>();
	if (!r?.web_key) return c.text("no web version", 404);
	return serveObject(c, r.web_key);
});

app.get("/api/me", (c) => c.json({ who: who(c) }));

// Everything else: the static web UI.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
