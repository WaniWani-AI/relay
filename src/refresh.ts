import { applyRules, type MatchRules } from "./logic/decide";
import { settings } from "./settings";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** The match rules in a rules file from the app (the `data` of its answer), or null when it does not have the expected form. A malformed range makes `applyRules` throw instead. */
export function parseRemoteRules(body: unknown): MatchRules | null {
	if (!isObject(body) || body.version !== 1) {
		return null;
	}
	const { tokens, ipRanges } = body;
	if (!isStringArray(tokens) || !Array.isArray(ipRanges)) {
		return null;
	}
	const ranges: MatchRules["ipRanges"] = [];
	for (const range of ipRanges) {
		if (
			!isObject(range) ||
			!isStringArray(range.ipv4) ||
			!isStringArray(range.ipv6)
		) {
			return null;
		}
		ranges.push({ ipv4: range.ipv4, ipv6: range.ipv6 });
	}
	return {
		tokens: tokens.map((token) => token.toLowerCase()),
		ipRanges: ranges,
	};
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
