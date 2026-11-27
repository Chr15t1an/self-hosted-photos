#!/usr/bin/env node
// Make a clean, shareable copy of this repo: the committed files at HEAD, with no git history and no install's own
// wrangler.jsonc, in a new folder with a single fresh commit. Use it to publish the project without publishing
// your history (which may hold old secrets) or your settings.
//
//   npm run export-public -- <empty or new folder>
//
// It refuses to finish if any value from your wrangler.jsonc (account id, database id, hostname, Access team,
// owner emails) appears anywhere in the copy. Add more strings to block with PHOTOS_EXPORT_DENY="a,b".
// It never pushes anything.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROOT, readJsonc } from "./config.mjs";

const dest = process.argv[2] && resolve(process.argv[2]);
if (!dest) {
	console.error("usage: npm run export-public -- <empty or new folder>");
	process.exit(2);
}
if (existsSync(dest) && readdirSync(dest).length) {
	console.error(`${dest} is not empty.`);
	process.exit(2);
}
const git = (args, cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8" });
if (git(["status", "--porcelain", "--untracked-files=no"]).trim()) console.warn("note: uncommitted changes are NOT exported (only HEAD).");

// Values that must not leak: everything install-specific in wrangler.jsonc, plus anything extra you name.
const deny = new Set((process.env.PHOTOS_EXPORT_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
if (!existsSync(join(ROOT, "wrangler.jsonc"))) {
	console.error("No wrangler.jsonc, so there's nothing to check the copy against. Run this from your own install.");
	process.exit(2);
}
{
	const w = readJsonc(join(ROOT, "wrangler.jsonc"));
	const p = w.env?.production ?? {};
	deny.add(w.account_id);
	deny.add(p.d1_databases?.[0]?.database_id);
	const host = String(p.routes?.[0]?.pattern ?? "");
	deny.add(host);
	const labels = host.split(".");
	if (labels.length > 2) deny.add(labels.slice(1).join(".")); // the domain itself, e.g. example.com
	const team = String(p.vars?.ACCESS_TEAM_DOMAIN ?? "").replace(/^https:\/\//, "").split(".")[0];
	if (team && !team.includes("<")) deny.add(team); // the bare team name, not just <team>.cloudflareaccess.com
	for (const e of String(p.vars?.OWNER_EMAILS ?? "").split(",")) deny.add(e.trim());
}
for (const v of [...deny]) if (!v || v.includes("<")) deny.delete(v);

const files = git(["ls-files", "-z"]).split("\0").filter((f) => f && f !== "wrangler.jsonc");
const hits = [];
for (const f of files) {
	const buf = execFileSync("git", ["show", `HEAD:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 });
	const text = buf.toString("utf8");
	for (const v of deny) if (text.toLowerCase().includes(v.toLowerCase())) hits.push(`${f}: contains "${v}"`);
	// Any real-looking email address (placeholders on example.com / example.test and noreply addresses are fine).
	if (!f.endsWith("package-lock.json")) {
		for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g)) {
			if (!/@(example\.(com|org|net|test)|users\.noreply\.github\.com)$/i.test(m[0])) hits.push(`${f}: email address "${m[0]}"`);
		}
		if (/\/Users\/[a-z]|\/home\/[a-z]/.test(text)) hits.push(`${f}: a home-directory path`);
	}
	mkdirSync(dirname(join(dest, f)), { recursive: true });
	writeFileSync(join(dest, f), buf);
}
if (hits.length) {
	console.error(`Not exported cleanly: install-specific values found. Fix these in the repo, commit, and run again.\n  ${hits.join("\n  ")}`);
	console.error(`(The copy in ${dest} is incomplete; delete it.)`);
	process.exit(1);
}

const ignore = join(dest, ".gitignore");
const lines = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
if (!/^wrangler\.jsonc$/m.test(lines)) writeFileSync(ignore, `${lines.replace(/\n?$/, "\n")}# made by \`npm run setup\`; holds your account's ids\nwrangler.jsonc\n`);

git(["init", "-q", "-b", "main"], dest);
git(["add", "-A"], dest);
execFileSync("git", ["-c", "user.name=photo-app", "-c", "user.email=photo-app@users.noreply.github.com", "commit", "-q", "-m", "photo-app: self-hosted family photo and video library on Cloudflare"], { cwd: dest });
console.log(`Exported ${files.length} files to ${dest} as one fresh commit, checked against ${deny.size} install-specific values.`);
console.log("Nothing was pushed. Review it, then push it to a new repository yourself.");
