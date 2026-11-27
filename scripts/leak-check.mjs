#!/usr/bin/env node
// Leak check: this repo is public, so make sure nothing install-specific or personal is about to be published.
// It scans every tracked file at HEAD and, with --range, the commit messages being pushed, for:
//   - the values in your wrangler.jsonc (account id, database id, hostname, its domain, Access team, owner emails)
//   - any line in ~/.config/photos/leak-deny.txt (your own list: names, places, other projects; one per line,
//     # for comments; it never leaves your computer)
//   - any real-looking email address (example.com / example.test / noreply addresses are fine)
//   - home-directory paths (/Users/<name>, /home/<name>)
//
//   npm run leak-check                      # files at HEAD
//   node scripts/leak-check.mjs --range A..B  # also the messages of commits A..B (the pre-push hook uses this)
//   npm run hooks                           # install the pre-push hook that runs it before every push
//
// Exit 1 lists every hit; fix the file (or reword the commit with `git commit --amend` / rebase) and push again.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, readJsonc } from "./config.mjs";

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

if (process.argv[2] === "--install-hook") {
	const hook = join(git(["rev-parse", "--git-path", "hooks"]).trim(), "pre-push");
	const abs = hook.startsWith("/") ? hook : join(ROOT, hook);
	writeFileSync(abs, `#!/bin/sh
# Installed by \`npm run hooks\`: block a push that would publish install-specific or personal details.
z=0000000000000000000000000000000000000000
while read local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$z" ] && continue
  if [ "$remote_sha" = "$z" ]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  node "$(git rev-parse --show-toplevel)/scripts/leak-check.mjs" --range "$range" --at "$local_sha" || exit 1
done
`);
	chmodSync(abs, 0o755);
	console.log(`installed ${abs}`);
	process.exit(0);
}

const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const at = arg("--at") ?? "HEAD";
const range = arg("--range");

// What must not appear.
const deny = new Set();
const wranglerPath = join(ROOT, "wrangler.jsonc");
if (existsSync(wranglerPath)) {
	const w = readJsonc(wranglerPath);
	const p = w.env?.production ?? {};
	deny.add(w.account_id);
	deny.add(p.d1_databases?.[0]?.database_id);
	const host = String(p.routes?.[0]?.pattern ?? "");
	deny.add(host);
	const labels = host.split(".");
	if (labels.length > 2) deny.add(labels.slice(1).join("."));
	const team = String(p.vars?.ACCESS_TEAM_DOMAIN ?? "").replace(/^https:\/\//, "").split(".")[0];
	deny.add(team);
	for (const e of String(p.vars?.OWNER_EMAILS ?? "").split(",")) deny.add(e.trim());
} else {
	console.warn("leak-check: no wrangler.jsonc, so your install's own values aren't checked.");
}
const denyFile = process.env.PHOTOS_LEAK_DENY ?? join(homedir(), ".config/photos/leak-deny.txt");
if (existsSync(denyFile)) {
	for (const line of readFileSync(denyFile, "utf8").split("\n")) {
		const v = line.replace(/#.*/, "").trim();
		if (v) deny.add(v);
	}
}
for (const v of [...deny]) if (!v || v.includes("<") || v.length < 3) deny.delete(v);
const denyLower = [...deny].map((v) => [v, v.toLowerCase()]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g;
const OK_EMAIL = /@(example\.(com|org|net|test)|users\.noreply\.github\.com|anthropic\.com)$/i;
const HOME = /\/Users\/[a-z]|\/home\/[a-z]/;

function scan(label, text, { emails = true } = {}) {
	const hits = [];
	const lower = text.toLowerCase();
	for (const [v, l] of denyLower) if (lower.includes(l)) hits.push(`${label}: contains "${v}"`);
	if (emails) for (const m of text.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) hits.push(`${label}: email address "${m[0]}"`);
	if (HOME.test(text)) hits.push(`${label}: a home-directory path`);
	return hits;
}

const hits = [];
const files = git(["ls-tree", "-r", "-z", "--name-only", at]).split("\0").filter(Boolean);
for (const f of files) {
	const text = execFileSync("git", ["show", `${at}:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 }).toString("utf8");
	hits.push(...scan(f, text, { emails: !f.endsWith("package-lock.json") }));
}
let commits = 0;
if (range) {
	const shas = git(["rev-list", range]).split("\n").filter(Boolean);
	for (const sha of shas) {
		commits++;
		const msg = git(["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", sha]);
		// Author lines are checked against the deny list and home paths, not the email rule: your git identity is yours to choose.
		hits.push(...scan(`commit ${sha.slice(0, 7)}`, msg, { emails: false }));
		const body = msg.split("\n").slice(2).join("\n");
		for (const m of body.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) hits.push(`commit ${sha.slice(0, 7)}: email address "${m[0]}"`);
	}
}

if (hits.length) {
	console.error(`leak-check: ${hits.length} problem(s). This repo is public; nothing was pushed.\n  ${[...new Set(hits)].join("\n  ")}`);
	process.exit(1);
}
console.log(`leak-check: clean (${files.length} files${range ? `, ${commits} commit message(s)` : ""}, ${deny.size} private values${existsSync(denyFile) ? "" : "; no leak-deny.txt"})`);
