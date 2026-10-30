import { vercelRequestContext } from "./wait-until";

export type Platform = "vercel" | "cloudflare" | "cloudfront";

/** The platform this request runs on, or undefined on a runtime the relay does not know. Never throws. */
export function detectPlatform(): Platform | undefined {
	try {
		const context = vercelRequestContext();
		if (typeof context === "object" && context !== null) {
			return "vercel";
		}
		if (globalThis.navigator?.userAgent === "Cloudflare-Workers") {
			return "cloudflare";
		}
	} catch {}
	return undefined;
}
