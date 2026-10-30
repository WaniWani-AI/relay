import { isIPv4, isIPv6 } from "node:net";
import { applyRules, type MatchRules } from "./logic/decide";
import { settings } from "./settings";

const MAX_TOKENS = 5000;
const MAX_PREFIXES = 50_000;
const MIN_TOKEN_LENGTH = 4;
const MAX_TOKEN_LENGTH = 128;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const isCidr = (cidr: string, family: "ipv4" | "ipv6"): boolean => {
	const [address = "", prefix, extra] = cidr.split("/");
	if (
		extra !== undefined ||
		prefix === undefined ||
		!/^\d{1,3}$/.test(prefix)
	) {
		return false;
	}
	const bits = Number(prefix);
	return family === "ipv4"
		? isIPv4(address) && bits >= 16 && bits <= 32
		: isIPv6(address) && bits >= 32 && bits <= 128;
};

const isToken = (token: string): boolean =>
	/^[a-z0-9][a-z0-9._/ -]*$/.test(token) &&
	/[a-z]{3}/.test(token) &&
	token.length >= MIN_TOKEN_LENGTH &&
	token.length <= MAX_TOKEN_LENGTH &&
	token === token.toLowerCase();

/** The match rules in a rules file from the app (the `data` of its answer), or null when any part of it fails a check. */
export function parseRemoteRules(body: unknown): MatchRules | null {
	if (!isObject(body) || body.version !== 1) {
		return null;
	}
	const { tokens, ipRanges } = body;
	if (
		!isStringArray(tokens) ||
		tokens.length === 0 ||
		tokens.length > MAX_TOKENS ||
		!tokens.every(isToken) ||
		!Array.isArray(ipRanges)
	) {
		return null;
	}

	const ranges: MatchRules["ipRanges"] = [];
	let prefixes = 0;
	for (const range of ipRanges) {
		if (
			!isObject(range) ||
			!isStringArray(range.ipv4) ||
			!isStringArray(range.ipv6) ||
			!range.ipv4.every((cidr) => isCidr(cidr, "ipv4")) ||
			!range.ipv6.every((cidr) => isCidr(cidr, "ipv6"))
		) {
			return null;
		}
		prefixes += range.ipv4.length + range.ipv6.length;
		ranges.push({ ipv4: range.ipv4, ipv6: range.ipv6 });
	}
	if (prefixes > MAX_PREFIXES) {
		return null;
	}

	return { tokens, ipRanges: ranges };
}

let lastAttemptOk = false;
let lastAttemptAt = Number.NEGATIVE_INFINITY;

async function fetchRules(apiUrl: string): Promise<boolean> {
	const response = await fetch(`${apiUrl}/api/v2/agent-traffic/rules`, {
		signal: AbortSignal.timeout(settings.requestTimeoutMs),
	});
	if (!response.ok) {
		return false;
	}
	const body: unknown = await response.json();
	const rules = parseRemoteRules(isObject(body) ? body.data : null);
	if (!rules) {
		return false;
	}
	applyRules(rules);
	return true;
}

/**
 * Starts one fetch of the rules file when the last attempt succeeded more than the refresh interval ago,
 * or failed more than the retry interval ago. Returns that work, or null.
 */
export function refreshRules(apiUrl: string): Promise<void> | null {
	const now = Date.now();
	const wait = lastAttemptOk ? settings.rulesRefreshMs : settings.rulesRetryMs;
	if (now - lastAttemptAt < wait) {
		return null;
	}
	lastAttemptAt = now;
	lastAttemptOk = false;
	return fetchRules(apiUrl).then(
		(ok) => {
			lastAttemptOk = ok;
		},
		() => undefined,
	);
}
