// Shared settings for the setup and deploy scripts. Every per-install value lives in wrangler.jsonc (made by
// `npm run setup` from wrangler.example.jsonc), so there is one place to edit:
//   account_id                              the Cloudflare account
//   env.production.routes[0].pattern        the hostname, e.g. photos.example.com
//   env.production.vars.ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   env.production.vars.OWNER_EMAILS        who can sign in, comma-separated
//   env.production.d1_databases[0]          the D1 database
//   env.production.r2_buckets[0]            the R2 bucket
//
// Credentials never go in the repo. Scripts read them from the environment first, then from
// ~/.config/photos/credentials.env (the deploy script writes the CLI's service token there).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CREDENTIALS = process.env.PHOTOS_CREDENTIALS_FILE ?? join(homedir(), ".config/photos/credentials.env");

/** JSONC → object. Strips full-line and trailing // comments that are outside strings. */
export function readJsonc(path) {
	const text = readFileSync(path, "utf8")
		.split("\n")
		.map((line) => {
			let inStr = false;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (ch === "\\" && inStr) i++;
				else if (ch === '"') inStr = !inStr;
				else if (!inStr && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
			}
			return line;
		})
		.join("\n")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(text);
}

export function loadConfig() {
	const path = join(ROOT, "wrangler.jsonc");
	if (!existsSync(path)) throw new Error("No wrangler.jsonc yet. Run `npm run setup` first (see docs/SETUP.md).");
	const w = readJsonc(path);
	const prod = w.env?.production ?? {};
	const host = prod.routes?.[0]?.pattern;
	const emails = String(prod.vars?.OWNER_EMAILS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const cfg = {
		account: w.account_id,
		host,
		appName: prod.name ?? "photo-app",
		team: prod.vars?.ACCESS_TEAM_DOMAIN,
		emails,
		d1Name: prod.d1_databases?.[0]?.database_name,
		bucket: prod.r2_buckets?.[0]?.bucket_name,
	};
	for (const [k, v] of Object.entries({ account_id: cfg.account, "routes[0].pattern": cfg.host, ACCESS_TEAM_DOMAIN: cfg.team, OWNER_EMAILS: emails.length ? 1 : "", d1_databases: cfg.d1Name, r2_buckets: cfg.bucket })) {
		if (!v || String(v).includes("<")) throw new Error(`wrangler.jsonc: ${k} is not set (still a <placeholder>?). Re-run \`npm run setup\`.`);
	}
	return cfg;
}

/** A credential: the environment first, then ~/.config/photos/credentials.env. */
export function credential(name) {
	if (process.env[name]) return process.env[name];
	try {
		const m = readFileSync(CREDENTIALS, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
		if (m) return m[1].trim().replace(/^["']|["']$/g, "");
	} catch {}
	return undefined;
}

/** Append KEY=value lines to the credentials file (mode 600). */
export function saveCredentials(pairs) {
	mkdirSync(dirname(CREDENTIALS), { recursive: true, mode: 0o700 });
	appendFileSync(CREDENTIALS, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
}

export async function cfApi(token, path, { method = "GET", body } = {}) {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const j = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
	if (!j.success) throw Object.assign(new Error(`${method} ${path}: ${JSON.stringify(j.errors)}`), { errors: j.errors, status: res.status });
	return j.result;
}
