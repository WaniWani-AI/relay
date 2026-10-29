export const HEADER_CAP: readonly string[] = [
	"user-agent",
	"referer",
	"accept",
	"accept-language",
	"from",
	"signature-agent",
	"signature-input",
	"signature",
	"dpop",
	"sec-ch-ua",
	"sec-ch-ua-platform",
	"sec-ch-ua-mobile",
	"authorization",
];

const KNOWN_SCHEMES = new Map(
	[
		"Basic",
		"Bearer",
		"Digest",
		"DPoP",
		"HOBA",
		"Mutual",
		"Negotiate",
		"NTLM",
		"OAuth",
		"PrivateToken",
		"SCRAM-SHA-1",
		"SCRAM-SHA-256",
		"vapid",
		"AWS4-HMAC-SHA256",
	].map((scheme) => [scheme.toLowerCase(), scheme]),
);

/** The canonical name of a known Authorization scheme, kept only when a credential follows it. */
export function authorizationScheme(value: string): string | null {
	const parts = value.trim().split(/\s+/);
	if (parts.length < 2) {
		return null;
	}
	return KNOWN_SCHEMES.get((parts[0] ?? "").toLowerCase()) ?? null;
}

export function readCappedHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of HEADER_CAP) {
		const value = headers.get(name);
		if (value === null) {
			continue;
		}
		if (name === "authorization") {
			const scheme = authorizationScheme(value);
			if (scheme !== null) {
				out[name] = scheme;
			}
		} else {
			out[name] = value;
		}
	}
	return out;
}

/** Cloudflare appends the real IP to a client-sent `X-Forwarded-For`, so `CF-Connecting-IP` comes first. */
export function clientIp(headers: Headers): string | null {
	const forwarded = headers.get("x-forwarded-for");
	const candidate =
		headers.get("cf-connecting-ip") ??
		(forwarded !== null ? forwarded.split(",")[0] : headers.get("x-real-ip"));
	const ip = candidate?.trim().toLowerCase();
	return ip ? ip : null;
}
