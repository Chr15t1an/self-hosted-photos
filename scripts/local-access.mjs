// A stand-in Cloudflare Access for the local stack: one RS256 key, its JWKS at /cdn-cgi/access/certs, and signed
// JWTs written to files (never printed):
//   node scripts/local-jwks.mjs <port> [out-dir]
// out-dir (default $TMPDIR/photo-app-local) gets owner.jwt (email = the first OWNER_EMAILS entry in wrangler.jsonc),
// other.jwt (other@example.test) and service.jwt (common_name local-svc.access). aud = local-test,
// iss = http://127.0.0.1:<port> — start wrangler dev with ACCESS_AUD=local-test and ACCESS_TEAM_DOMAIN=<that iss>.
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_AUD = "local-test";
export const LOCAL_SERVICE = "local-svc.access";
export const OTHER_EMAIL = "other@example.test";

/** wrangler.jsonc with its full-line // comments removed. */
export function readWranglerConfig() {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const text = readFileSync(join(root, "wrangler.jsonc"), "utf8")
		.split("\n")
		.filter((l) => !l.trim().startsWith("//"))
		.join("\n");
	return JSON.parse(text);
}

export function ownerEmails(cfg, production = false) {
	const vars = production ? cfg.env?.production?.vars : cfg.vars;
	return String(vars?.OWNER_EMAILS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export function startLocalAccess(port, outDir = join(tmpdir(), "photo-app-local")) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-1", alg: "RS256", use: "sig" };
	const iss = `http://127.0.0.1:${port}`;
	const sign = (claims) => {
		const now = Math.floor(Date.now() / 1000);
		const head = b64u({ alg: "RS256", kid: "local-1", typ: "JWT" });
		const body = b64u({ aud: [LOCAL_AUD], iss, iat: now, exp: now + 6 * 3600, ...claims });
		const s = createSign("RSA-SHA256");
		s.update(`${head}.${body}`);
		return `${head}.${body}.${s.sign(privateKey).toString("base64url")}`;
	};
	const owner = ownerEmails(readWranglerConfig())[0];
	if (!owner) throw new Error("wrangler.jsonc has no OWNER_EMAILS");
	mkdirSync(outDir, { recursive: true });
	const files = { owner: join(outDir, "owner.jwt"), other: join(outDir, "other.jwt"), service: join(outDir, "service.jwt") };
	writeFileSync(files.owner, sign({ email: owner }), { mode: 0o600 });
	writeFileSync(files.other, sign({ email: OTHER_EMAIL }), { mode: 0o600 });
	writeFileSync(files.service, sign({ common_name: LOCAL_SERVICE }), { mode: 0o600 });
	const server = createServer((req, res) => {
		if (req.url === "/cdn-cgi/access/certs") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ keys: [jwk] }));
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve({ server, iss, files })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [port, out] = process.argv.slice(2);
	if (!port) {
		console.error("usage: node scripts/local-jwks.mjs <port> [out-dir]");
		process.exit(2);
	}
	const { iss, files } = await startLocalAccess(port, out);
	console.log(`local access on ${iss}; jwts in ${dirname(files.owner)}`);
}
