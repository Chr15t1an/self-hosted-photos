#!/usr/bin/env node
// One-time setup for a new install. Creates the R2 bucket and the D1 database on your Cloudflare account (or reuses
// them if they exist), finds your Access team domain, and writes wrangler.jsonc from wrangler.example.jsonc.
// Nothing goes live: `npm run deploy` does that afterwards.
//
//   npm run setup -- --host photos.example.com --emails you@example.com,partner@example.com
//                    [--account <account id>] [--name photo-app] [--bucket photo-app-originals] [--force]
//
// Needs CLOUDFLARE_API_TOKEN in the environment (or ~/.config/photos/credentials.env). docs/SETUP.md lists the
// permissions it needs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, cfApi, credential } from "./config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const fail = (msg) => {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
};

const host = opt("host")?.toLowerCase();
const emails = (opt("emails") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const name = opt("name", "photo-app");
const bucket = opt("bucket", `${name}-originals`);
if (!host || !emails.length) {
	fail("usage: npm run setup -- --host photos.example.com --emails you@example.com[,partner@example.com]");
}
if (!/^[a-z0-9-]+$/.test(name)) fail("--name may only use a-z, 0-9 and -");
const target = join(ROOT, "wrangler.jsonc");
if (existsSync(target) && !args.includes("--force")) fail("wrangler.jsonc already exists. Pass --force to overwrite it.");

const token = credential("CLOUDFLARE_API_TOKEN");
if (!token) fail("Set CLOUDFLARE_API_TOKEN first (docs/SETUP.md, step 2).");
const cf = (path, opts) => cfApi(token, path, opts);

// 1. The account.
let account = opt("account");
if (!account) {
	const accounts = await cf("/accounts");
	if (accounts.length !== 1) {
		fail(`Your token sees ${accounts.length} accounts. Pick one with --account:\n` + accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n"));
	}
	account = accounts[0].id;
}
console.log(`✓ account ${account}`);

// 2. The domain must already be on this account.
let zone;
for (let labels = host.split("."), i = 0; i < labels.length - 1 && !zone; i++) {
	[zone] = await cf(`/zones?name=${labels.slice(i).join(".")}&account.id=${account}`);
}
if (!zone) fail(`No zone on this account covers ${host}. Add your domain to Cloudflare first (docs/SETUP.md, step 1).`);
console.log(`✓ domain ${zone.name} is on Cloudflare`);

// 3. The Access team (Zero Trust organization).
let team;
try {
	const org = await cf(`/accounts/${account}/access/organizations`);
	team = org?.auth_domain && `https://${org.auth_domain}`;
} catch {}
if (!team) {
	fail("Cloudflare Access isn't set up on this account yet. Open the Cloudflare dashboard → Zero Trust once, choose a team\n" +
		"  name and the Free plan, then run this again (docs/SETUP.md, step 3). If you did, check the token has\n" +
		"  Account → Access: Organizations, Identity Providers, and Groups → Read.");
}
console.log(`✓ Access team ${team}`);

// 4. The R2 bucket.
try {
	await cf(`/accounts/${account}/r2/buckets/${bucket}`);
	console.log(`✓ R2 bucket ${bucket} (already there)`);
} catch (e) {
	if (e.status !== 404 && !String(e.message).includes("10006")) {
		fail(`Couldn't read R2: ${e.message}\n  If R2 isn't enabled yet, open the dashboard → R2 once and turn it on (it asks for a payment method).`);
	}
	await cf(`/accounts/${account}/r2/buckets`, { method: "POST", body: { name: bucket } });
	console.log(`✓ R2 bucket ${bucket} (created, private)`);
}

// 5. The D1 database.
let [db] = (await cf(`/accounts/${account}/d1/database?name=${name}`)).filter((d) => d.name === name);
if (db) console.log(`✓ D1 database ${name} (already there)`);
else {
	db = await cf(`/accounts/${account}/d1/database`, { method: "POST", body: { name } });
	console.log(`✓ D1 database ${name} (created)`);
}

// 6. wrangler.jsonc.
const values = {
	APP_NAME: name,
	ACCOUNT_ID: account,
	BUCKET: bucket,
	D1_NAME: name,
	D1_ID: db.uuid,
	TEAM_DOMAIN: team,
	OWNER_EMAILS: emails.join(","),
	HOSTNAME: host,
};
let text = readFileSync(join(ROOT, "wrangler.example.jsonc"), "utf8");
text = text.replace("// Made from wrangler.example.jsonc by `npm run setup`. Every per-install value is one of the <placeholders> below.",
	`// Made by \`npm run setup\` on ${new Date().toISOString().slice(0, 10)}. Edit OWNER_EMAILS below to change who can sign in.`);
for (const [k, v] of Object.entries(values)) text = text.replaceAll(`<${k}>`, v);
const left = text.match(/<[A-Z_]+>/);
if (left) fail(`wrangler.example.jsonc has a placeholder setup doesn't know: ${left[0]}`);
writeFileSync(target, text);
console.log(`✓ wrote wrangler.jsonc\n\nNext: npm run deploy   (puts it live at https://${host}, behind Access, for ${emails.join(", ")})`);
