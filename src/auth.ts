import { verifyWithJwks } from "hono/jwt";

type HonoJsonWebKey = NonNullable<Parameters<typeof verifyWithJwks>[1]["keys"]>[number];
type JWTPayload = Awaited<ReturnType<typeof verifyWithJwks>>;

/**
 * Cloudflare Access JWT verification.
 *
 * Access sits in front of the Worker and adds `Cf-Access-Jwt-Assertion` to every request it lets through. We still
 * verify it here (signature against the team's JWKS, `aud`, `iss`, `exp`) so a request that reaches the Worker any
 * other way (workers.dev, a missing Access app) is refused.
 */

export const ACCESS_HEADER = "cf-access-jwt-assertion";
/** The cookie Access sets after a browser sign-in; the same JWT as the header (fallback, plan Decision 6). */
export const ACCESS_COOKIE = "CF_Authorization";

/** Who the token says is calling: a person (`email`) or a service token (`service:<client id>`). */
export interface Identity {
	id: string;
	email?: string;
	service?: string;
}

/** Who the app lets in: one of the owners, or an allowed service token. */
export type Caller = { kind: "person"; email: string } | { kind: "service"; clientId: string };

export interface AccessConfig {
	teamDomain: string;
	aud: string;
}

export type Verifier = (token: string) => Promise<Identity>;

type KeyLoader = (teamDomain: string) => Promise<HonoJsonWebKey[]>;

const KEY_TTL_MS = 60 * 60 * 1000;
const REFRESH_FLOOR_MS = 60 * 1000;
const keyCache = new Map<string, { keys: HonoJsonWebKey[]; at: number }>();

export async function fetchAccessKeys(teamDomain: string): Promise<HonoJsonWebKey[]> {
	const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`access certs ${res.status}`);
	const body = (await res.json()) as { keys?: HonoJsonWebKey[] };
	if (!body.keys?.length) throw new Error("access certs: no keys");
	return body.keys;
}

export function identityFromPayload(payload: JWTPayload): Identity {
	const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
	if (email) return { id: email, email };
	const cn = typeof payload.common_name === "string" ? payload.common_name : undefined;
	if (cn) return { id: `service:${cn}`, service: cn };
	throw new Error("access token carries neither email nor common_name");
}

/** Build a verifier; keys are cached per team domain and refetched once on a failure (key rotation). */
export function accessVerifier(cfg: AccessConfig, loadKeys: KeyLoader = fetchAccessKeys): Verifier {
	const teamDomain = cfg.teamDomain.replace(/\/+$/, "");
	const verifyWith = (keys: HonoJsonWebKey[], token: string) =>
		verifyWithJwks(token, {
			keys,
			allowedAlgorithms: ["RS256"],
			verification: { aud: cfg.aud, iss: teamDomain },
		});

	return async (token: string) => {
		let cached = keyCache.get(teamDomain);
		if (!cached || Date.now() - cached.at > KEY_TTL_MS) {
			cached = { keys: await loadKeys(teamDomain), at: Date.now() };
			keyCache.set(teamDomain, cached);
		}
		try {
			return identityFromPayload(await verifyWith(cached.keys, token));
		} catch (err) {
			if (Date.now() - cached.at < REFRESH_FLOOR_MS) throw err;
			const fresh = { keys: await loadKeys(teamDomain), at: Date.now() };
			keyCache.set(teamDomain, fresh);
			return identityFromPayload(await verifyWith(fresh.keys, token));
		}
	};
}

/** Test hook: forget cached keys. */
export function clearAccessKeyCache(): void {
	keyCache.clear();
}

/** The Access JWT: the `Cf-Access-Jwt-Assertion` header first, else the `CF_Authorization` cookie. */
export function tokenFrom(req: Request): string | null {
	const header = req.headers.get(ACCESS_HEADER)?.trim();
	if (header) return header;
	const cookie = req.headers.get("cookie");
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		if (part.slice(0, i).trim() === ACCESS_COOKIE) {
			const v = part.slice(i + 1).trim();
			return v || null;
		}
	}
	return null;
}

function list(v: string | undefined, lower: boolean): string[] {
	return (v ?? "")
		.split(",")
		.map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
		.filter(Boolean);
}

/** An owner email or an allowed service token → a caller; anyone else → null. */
export function authorize(identity: Identity, env: { OWNER_EMAILS?: string; ACCESS_SERVICE_CLIENT_IDS?: string }): Caller | null {
	if (identity.email) {
		const email = identity.email.trim().toLowerCase();
		return list(env.OWNER_EMAILS, true).includes(email) ? { kind: "person", email } : null;
	}
	if (identity.service) {
		return list(env.ACCESS_SERVICE_CLIENT_IDS, false).includes(identity.service) ? { kind: "service", clientId: identity.service } : null;
	}
	return null;
}

/** The owner emails as configured (lower-cased). */
export function ownerEmails(env: { OWNER_EMAILS?: string }): string[] {
	return list(env.OWNER_EMAILS, true);
}
