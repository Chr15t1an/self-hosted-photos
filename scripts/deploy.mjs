#!/usr/bin/env node
// Production deploy, Access first:
//   0. Refuse to take over a hostname that already has a DNS record of its own (unless --replace-dns).
//   1. Create the CLI's Access service token once and save it to ~/.config/photos/credentials.env.
//   2. Create or update the Cloudflare Access app for your hostname, with
//        - an allow policy for exactly the emails in wrangler.jsonc env.production.vars.OWNER_EMAILS, and
//        - a service-auth policy for the CLI's service token.
//   3. Apply the D1 migrations, then `wrangler deploy --env production` with ACCESS_AUD and
//      ACCESS_SERVICE_CLIENT_IDS as secrets.
//   4. Smoke test: no credentials → Access login redirect; service token → /api/me answers.
// Re-run it any time (for example after adding an email): every step is idempotent.
//
//   npm run deploy                     # do it
//   npm run deploy -- --replace-dns    # delete an existing DNS record for the hostname first
//   npm run access-setup               # steps 0-2 only (update who can sign in, no code deploy)
//
// Settings come from wrangler.jsonc (see scripts/config.mjs). Tokens, never printed:
//   Workers, R2, D1, DNS:                     CLOUDFLARE_API_TOKEN
//   Access (apps, policies, service tokens):  CLOUDFLARE_ACCESS_API_TOKEN, else CLOUDFLARE_API_TOKEN
// (Each is read from the environment, else ~/.config/photos/credentials.env.)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS, ROOT, cfApi, credential, loadConfig, saveCredentials } from "./config.mjs";

const cfg = loadConfig();
const HOST = cfg.host;
const TOKEN_NAME = `${cfg.appName}-cli`;

const CF_TOKEN = credential("CLOUDFLARE_API_TOKEN");
if (!CF_TOKEN) throw new Error("No Cloudflare API token: set CLOUDFLARE_API_TOKEN (see docs/SETUP.md for its permissions).");
const ACCESS_TOKEN = credential("CLOUDFLARE_ACCESS_API_TOKEN") ?? CF_TOKEN;
const CLIENT_ID = () => credential("PHOTOS_CLIENT_ID");
const CLIENT_SECRET = () => credential("PHOTOS_CLIENT_SECRET");

const cf = (path, { base = `/accounts/${cfg.account}`, ...opts } = {}) =>
	cfApi(path.startsWith("/access/") ? ACCESS_TOKEN : CF_TOKEN, `${base}${path}`, opts).catch((e) => {
		if (path.startsWith("/access/") && e.status === 403) {
			e.message += "\n→ Your token can't manage Access. Add Account → Access: Apps and Policies → Edit and Access: Service Tokens → Edit (docs/SETUP.md).";
		}
		throw e;
	});

async function ensureServiceToken() {
	const id = CLIENT_ID();
	const tokens = await cf("/access/service_tokens");
	const existing = tokens.find((t) => t.name === TOKEN_NAME);
	if (existing && id && existing.client_id === id) return existing;
	if (existing) throw new Error(`Service token ${TOKEN_NAME} exists but its secret is not in ${CREDENTIALS}; delete it in Zero Trust → Access → Service auth and re-run`);
	const t = await cf("/access/service_tokens", { method: "POST", body: { name: TOKEN_NAME, duration: "8760h" } });
	saveCredentials({ PHOTOS_CLIENT_ID: t.client_id, PHOTOS_CLIENT_SECRET: t.client_secret });
	console.log(`created service token ${TOKEN_NAME} (saved to ${CREDENTIALS}, expires in 1 year)`);
	return t;
}

async function ensureAccessApp(token) {
	const policies = [
		{ name: `${cfg.appName} owners`, decision: "allow", include: cfg.emails.map((email) => ({ email: { email } })), precedence: 1 },
		{ name: `${cfg.appName} cli`, decision: "non_identity", include: [{ service_token: { token_id: token.id } }], precedence: 2 },
	];
	const body = {
		name: cfg.appName,
		type: "self_hosted",
		domain: HOST,
		session_duration: "720h",
		app_launcher_visible: false,
		policies,
	};
	const apps = await cf("/access/apps");
	const found = apps.find((a) => a.domain === HOST);
	const app = found ? await cf(`/access/apps/${found.id}`, { method: "PUT", body }) : await cf("/access/apps", { method: "POST", body });
	console.log(`${found ? "updated" : "created"} Access app ${cfg.appName} for ${HOST}: owners = ${cfg.emails.length} email(s), plus the CLI token`);
	return app;
}

async function smoke() {
	const bare = await fetch(`https://${HOST}/`, { redirect: "manual" });
	const loc = bare.headers.get("location") ?? "";
	console.log(`no credentials → ${bare.status} ${loc.includes("cloudflareaccess.com") ? "(Access login, good)" : "(NOT the Access login — check!)"}`);
	const me = await fetch(`https://${HOST}/api/me`, { headers: { "cf-access-client-id": CLIENT_ID(), "cf-access-client-secret": CLIENT_SECRET() }, redirect: "manual" });
	console.log(`service token → ${me.status} ${await me.text()}`);
}

/** The zone that holds HOST: the longest zone name on the account that HOST ends with. */
async function zoneFor(host) {
	const labels = host.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const [z] = await cf(`/zones?name=${labels.slice(i).join(".")}&account.id=${cfg.account}`, { base: "" });
		if (z) return z;
	}
	throw new Error(`No Cloudflare zone on this account covers ${host}. Add the domain to Cloudflare first (docs/SETUP.md).`);
}

/** Refuse to take over a hostname that already has a DNS record the Worker doesn't own. */
async function checkHostIsFree() {
	const z = await zoneFor(HOST);
	const recs = await cf(`/zones/${z.id}/dns_records?name=${HOST}`, { base: "" });
	const foreign = recs.filter((r) => !(r.meta?.origin_worker_id || r.type === "AAAA" && r.content === "100::"));
	if (foreign.length && process.argv.includes("--replace-dns")) return { zoneId: z.id, foreign };
	if (foreign.length) {
		throw new Error(`${HOST} already has DNS records (${foreign.map((r) => `${r.type} ${r.content}`).join(", ")}). Nothing changed. ` +
			"Delete them in the dashboard, or re-run with --replace-dns once you're sure they're unused.");
	}
	return { zoneId: z.id, foreign: [] };
}

const dns = await checkHostIsFree();
const token = await ensureServiceToken();
const app = await ensureAccessApp(token);
if (!credential("PHOTOS_URL")) saveCredentials({ PHOTOS_URL: `https://${HOST}` });
if (process.argv.includes("--access")) process.exit(0);

const dir = mkdtempSync(join(tmpdir(), "photo-app-"));
const secrets = join(dir, "secrets.json");
writeFileSync(secrets, JSON.stringify({ ACCESS_AUD: app.aud, ACCESS_SERVICE_CLIENT_IDS: token.client_id }), { mode: 0o600 });
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, stdio: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_TOKEN } });
try {
	for (const r of dns.foreign) {
		await cf(`/zones/${dns.zoneId}/dns_records/${r.id}`, { base: "", method: "DELETE" });
		console.log(`removed old DNS record ${r.type} ${HOST} → ${r.content} (--replace-dns)`);
	}
	wrangler(["d1", "migrations", "apply", cfg.d1Name, "--remote", "--env", "production"]);
	wrangler(["deploy", "--env", "production", "--secrets-file", secrets]);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
await new Promise((r) => setTimeout(r, 5000));
await smoke();
