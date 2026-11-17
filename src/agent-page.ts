import { settings } from "./settings";
import { RELAY_VERSION } from "./version";

export type SiteRules = {
	version: 1;
	pagesUrl: string;
	userAgentTokens: string[];
	deadlines: { headersMs: number; bodyMs: number; askMs: number };
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

/** Lowercase like the user agent they are matched against, with blank tokens dropped since they would match every request. */
const cleanTokens = (tokens: string[]): string[] =>
	tokens
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token !== "");

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
			blockedUserAgentTokens: cleanTokens(blocked),
			agentPages: {
				enabled: site.agentPages.enabled,
				paths: site.agentPages.paths,
			},
		});
	}
	return {
		version: 1,
		pagesUrl: pagesUrl.replace(/\/+$/, ""),
		userAgentTokens: cleanTokens(userAgentTokens),
		deadlines: {
			headersMs: deadlines.headersMs,
			bodyMs: deadlines.bodyMs,
			askMs: isPositive(deadlines.askMs)
				? deadlines.askMs
				: settings.askHeadersMs,
		},
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

async function readWithin(
	body: ReadableStream<Uint8Array>,
	ms: number,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMEOUT), ms);
	});
	try {
		return await readCapped(body, deadline, maxBytes);
	} finally {
		clearTimeout(timer);
	}
}

/** Reads a copy of the request body, so the original can still go to the origin. Null when the body is empty, larger than `maxBytes` or slower than `ms`. */
export async function readRequestBody(
	request: Request,
	maxBytes: number,
	ms: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (Number(request.headers.get("content-length")) > maxBytes) {
		return null;
	}
	const body = request.clone().body;
	const bytes = body ? await readWithin(body, ms, maxBytes) : null;
	return bytes && bytes.byteLength > 0 ? bytes : null;
}

export type PageFormat = "markdown" | "html";

type MediaRange = { type: string; q: number };

function mediaRanges(accept: string): MediaRange[] {
	return accept.split(",").map((range) => {
		const [type = "", ...params] = range
			.split(";")
			.map((part) => part.trim().toLowerCase());
		const q = params
			.map((param) => param.split("=").map((part) => part.trim()))
			.find(([name]) => name === "q");
		const value = q === undefined ? 1 : Number(q[1]);
		return { type, q: Number.isFinite(value) ? value : 0 };
	});
}

/** The highest q among the ranges of exactly this type, or null when none names it. */
function qualityOf(ranges: MediaRange[], type: string): number | null {
	const named = ranges.filter((range) => range.type === type);
	return named.length === 0 ? null : Math.max(...named.map((range) => range.q));
}

const markdownQuality = (ranges: MediaRange[]): number =>
	qualityOf(ranges, "text/markdown") ?? 0;

/** Markdown only when the agent lists `text/markdown` with a nonzero q, so an agent that asks for HTML or for anything gets HTML. */
export function pageFormat(accept: string): PageFormat {
	return markdownQuality(mediaRanges(accept)) > 0 ? "markdown" : "html";
}

/** Whether a client names `text/markdown` and ranks it at least as high as the most specific range that covers `text/html`. A browser never names `text/markdown`. */
export function prefersMarkdown(accept: string): boolean {
	const ranges = mediaRanges(accept);
	const markdown = markdownQuality(ranges);
	const html =
		qualityOf(ranges, "text/html") ??
		qualityOf(ranges, "text/*") ??
		qualityOf(ranges, "*/*") ??
		0;
	return markdown > 0 && markdown >= html;
}

export const ASK_PATH = "/ask";

/** The paths the service answers with JSON. Every other path must answer `text/*`. */
const JSON_PATHS = new Set([
	ASK_PATH,
	"/.well-known/ai-catalog.json",
	"/openapi.json",
	"/.well-known/mcp.json",
	"/.well-known/mcp/server-card.json",
]);

function servableType(path: string, contentType: string): boolean {
	const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	return (
		type.startsWith("text/") ||
		(JSON_PATHS.has(path) && type === "application/json")
	);
}

export type AgentPageRequest = {
	hostname: string;
	path: string;
	/** The query string without its `?`. */
	query: string;
	format: PageFormat;
	userAgent: string;
	/** The body of a `POST /ask`, which the relay forwards as a POST. Null for a GET. */
	body: Uint8Array<ArrayBuffer> | null;
};

export type AgentPage = {
	status: 200 | 429;
	body: Uint8Array<ArrayBuffer> | null;
	contentType: string | null;
	retryAfter: string | null;
};

/**
 * Fetches the stored page in the agent's format within both deadlines and the size cap, or null. The home page URL has no trailing slash, which the app would answer with a redirect.
 * `/ask` waits `askMs` for the headers, since the service searches before it answers.
 * A 429 for `/ask` comes back with its `Retry-After`, so the agent sees the rate limit. Any other answer that is not a 200 gives null.
 */
export async function fetchAgentPage(
	rules: SiteRules,
	page: AgentPageRequest,
): Promise<AgentPage | null> {
	const headers: Record<string, string> = {
		accept: page.format === "markdown" ? "text/markdown" : "text/html",
		"x-waniwani-relay": RELAY_VERSION,
	};
	if (page.userAgent !== "") {
		headers["x-waniwani-agent"] = page.userAgent;
	}
	const controller = new AbortController();
	const init: RequestInit = { headers, signal: controller.signal };
	if (page.body !== null) {
		init.method = "POST";
		init.body = page.body;
		headers["content-type"] = "application/json";
	}
	const path = page.path === "/" ? "" : page.path;
	const search = page.query === "" ? "" : `?${page.query}`;
	try {
		const response = await within(
			fetch(`${rules.pagesUrl}/${page.hostname}${path}${search}`, init),
			page.path === ASK_PATH
				? rules.deadlines.askMs
				: rules.deadlines.headersMs,
		);
		if (response === TIMEOUT) {
			return null;
		}
		const limited = response.status === 429 && page.path === ASK_PATH;
		const contentType = response.headers.get("content-type") ?? "";
		const servable = servableType(page.path, contentType) && response.body;
		if (limited) {
			const body = servable
				? await readWithin(servable, rules.deadlines.bodyMs, rules.maxBodyBytes)
				: null;
			if (!servable) {
				await response.body?.cancel().catch(() => {});
			}
			return {
				status: 429,
				body,
				contentType: body ? contentType : null,
				retryAfter: response.headers.get("retry-after"),
			};
		}
		if (response.status !== 200 || !servable) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		const body = await readWithin(
			servable,
			rules.deadlines.bodyMs,
			rules.maxBodyBytes,
		);
		return body ? { status: 200, body, contentType, retryAfter: null } : null;
	} catch {
		return null;
	} finally {
		controller.abort();
	}
}
