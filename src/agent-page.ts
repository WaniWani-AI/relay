import { settings } from "./settings";
import { RELAY_VERSION } from "./version";

export type SiteRules = {
	version: 1;
	pagesUrl: string;
	userAgentTokens: string[];
	deadlines: { headersMs: number; bodyMs: number };
	maxBodyBytes: number;
	sites: Array<{
		hostname: string;
		blockedUserAgentTokens: string[];
		agentPages: { enabled: boolean; paths: string[] };
	}>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const isPositive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/** The site rules in a serve rules file from the app (the `data` of its answer), or null when it does not have the expected form. */
export function parseSiteRules(body: unknown): SiteRules | null {
	if (!isObject(body) || body.version !== 1) {
		return null;
	}
	const { pagesUrl, userAgentTokens, deadlines, maxBodyBytes, sites } = body;
	if (
		typeof pagesUrl !== "string" ||
		!isStringArray(userAgentTokens) ||
		!isObject(deadlines) ||
		!isPositive(deadlines.headersMs) ||
		!isPositive(deadlines.bodyMs) ||
		!isPositive(maxBodyBytes) ||
		!Array.isArray(sites)
	) {
		return null;
	}
	const parsedSites: SiteRules["sites"] = [];
	for (const site of sites) {
		if (!isObject(site)) {
			return null;
		}
		const blocked = site.blockedUserAgentTokens ?? [];
		if (
			typeof site.hostname !== "string" ||
			!isStringArray(blocked) ||
			!isObject(site.agentPages) ||
			typeof site.agentPages.enabled !== "boolean" ||
			!isStringArray(site.agentPages.paths)
		) {
			return null;
		}
		parsedSites.push({
			hostname: site.hostname.toLowerCase(),
			blockedUserAgentTokens: blocked.filter((token) => token !== ""),
			agentPages: {
				enabled: site.agentPages.enabled,
				paths: site.agentPages.paths,
			},
		});
	}
	return {
		version: 1,
		pagesUrl: pagesUrl.replace(/\/+$/, ""),
		userAgentTokens: userAgentTokens.filter((token) => token !== ""),
		deadlines: { headersMs: deadlines.headersMs, bodyMs: deadlines.bodyMs },
		maxBodyBytes,
		sites: parsedSites,
	};
}

type CacheEntry = {
	rules: SiteRules | null;
	fetchedAt: number;
	lastAttemptAt: number;
	lastAttemptOk: boolean;
	inFlight: Promise<SiteRules | null> | null;
};

const cache = new Map<string, CacheEntry>();

async function fetchSiteRules(
	url: string,
	timeoutMs: number,
): Promise<SiteRules | null> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	const body: unknown = await response.json();
	return parseSiteRules(isObject(body) ? body.data : null);
}

function startFetch(
	entry: CacheEntry,
	url: string,
	timeoutMs: number,
): Promise<SiteRules | null> {
	const now = Date.now();
	entry.lastAttemptAt = now;
	entry.lastAttemptOk = false;
	const work = fetchSiteRules(url, timeoutMs)
		.catch(() => null)
		.then((rules) => {
			if (rules) {
				entry.rules = rules;
				entry.fetchedAt = Date.now();
				entry.lastAttemptOk = true;
			}
			entry.inFlight = null;
			return rules;
		});
	entry.inFlight = work;
	return work;
}

/**
 * The rules for this org. Awaits the first fetch, then serves the cache and refreshes it in the background once it is stale.
 * At most one fetch per org is in flight.
 */
export async function loadSiteRules(
	apiUrl: string,
	ingestToken: string,
	background: (work: Promise<unknown>) => void,
): Promise<SiteRules | null> {
	const url = `${apiUrl}/api/v2/agent-traffic/serve/${ingestToken}/rules`;
	let entry = cache.get(url);
	if (!entry) {
		entry = {
			rules: null,
			fetchedAt: 0,
			lastAttemptAt: Number.NEGATIVE_INFINITY,
			lastAttemptOk: false,
			inFlight: null,
		};
		cache.set(url, entry);
	}
	const now = Date.now();
	if (entry.rules) {
		const stale = now - entry.fetchedAt >= settings.siteRulesRefreshMs;
		const retryDue =
			entry.lastAttemptOk ||
			now - entry.lastAttemptAt >= settings.siteRulesRetryMs;
		if (stale && retryDue && !entry.inFlight) {
			background(startFetch(entry, url, settings.requestTimeoutMs));
		}
		return entry.rules;
	}
	if (entry.inFlight) {
		return entry.inFlight;
	}
	if (now - entry.lastAttemptAt < settings.siteRulesRetryMs) {
		return null;
	}
	return startFetch(entry, url, settings.siteRulesTimeoutMs);
}

/** The pathname without its trailing slashes, except for the root. */
export function normalizePath(pathname: string): string {
	const trimmed = pathname.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

/** Whether a path matches an exact entry like `/pricing`, or a folder entry like `/products/*` that also covers `/products`. */
export function matchesPath(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		if (pattern === "*" || pattern === "/*") {
			return true;
		}
		if (pattern.endsWith("/*")) {
			const folder = normalizePath(pattern.slice(0, -2));
			return path === folder || path.startsWith(`${folder}/`);
		}
		return path === normalizePath(pattern);
	});
}

const TIMEOUT = Symbol("timeout");

function within<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | typeof TIMEOUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMEOUT), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function readCapped(
	body: ReadableStream<Uint8Array>,
	deadline: Promise<typeof TIMEOUT>,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline]);
			if (result === TIMEOUT) {
				return null;
			}
			if (result.done) {
				break;
			}
			size += result.value.byteLength;
			if (size > maxBytes) {
				return null;
			}
			chunks.push(result.value);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Fetches the stored page within both deadlines and the size cap. Returns its body and content type, or null. */
export async function fetchAgentPage(
	rules: SiteRules,
	hostname: string,
	path: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string } | null> {
	const controller = new AbortController();
	try {
		const response = await within(
			fetch(`${rules.pagesUrl}/${hostname}${path}`, {
				headers: {
					accept: "text/markdown, text/html;q=0.9",
					"x-waniwani-relay": RELAY_VERSION,
				},
				signal: controller.signal,
			}),
			rules.deadlines.headersMs,
		);
		if (response === TIMEOUT) {
			return null;
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (
			response.status !== 200 ||
			!contentType.toLowerCase().startsWith("text/") ||
			!response.body
		) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<typeof TIMEOUT>((resolve) => {
			timer = setTimeout(() => resolve(TIMEOUT), rules.deadlines.bodyMs);
		});
		try {
			const body = await readCapped(
				response.body,
				deadline,
				rules.maxBodyBytes,
			);
			return body ? { body, contentType } : null;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	} finally {
		controller.abort();
	}
}
