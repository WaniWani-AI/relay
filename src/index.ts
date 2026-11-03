import {
	fetchAgentPage,
	loadSiteRules,
	matchesPath,
	normalizePath,
} from "./agent-page";
import { readCappedHeaders } from "./headers";
import { type PostPolicy, postEvent } from "./ingest";
import { readKey } from "./key";
import { decide } from "./logic";
import { deriveMatchKey } from "./match-key";
import type { Platform } from "./platform";
import { refreshRules } from "./refresh";
import {
	type CloudFrontRequest,
	isCloudFrontRequest,
	toRelayRequest,
} from "./request";
import { settings } from "./settings";
import { RELAY_VERSION } from "./version";
import { vercelWaitUntil } from "./wait-until";

export type { CloudFrontRequest };

export type Region = keyof typeof settings.apiUrls;

export type RelayOptions = {
	/** The region of your WaniWani organization. Defaults to `"us"`. */
	region?: Region;
	/** Overrides the host that `region` picks. */
	apiUrl?: string;
	/** Overrides `process.env.WANIWANI_AGENT_TRAFFIC_KEY`. */
	key?: string;
	/** Keeps the background post alive after the response. Defaults to the `waitUntil` of the Vercel request context. */
	waitUntil?: (promise: Promise<unknown>) => void;
	/** Header names, and the fields `matchKey`, `userAgent` or `referer`, to leave out of every event. */
	omit?: Array<string>;
	/** `"remote"` loads the newest AI bot list from WaniWani every 12 hours. `"bundled"` keeps the list shipped in this version. Defaults to `"remote"`. */
	rules?: "remote" | "bundled";
};

export type IsAgentOptions = Pick<
	RelayOptions,
	"region" | "apiUrl" | "waitUntil" | "rules"
>;

export type ServeAgentPageOptions = Pick<
	RelayOptions,
	"region" | "apiUrl" | "key"
>;

export type AgentVisitRecord = {
	occurredAt: string;
	method: string;
	host: string;
	path: string;
	userAgent?: string;
	referer?: string;
	headers: Record<string, string>;
	matchKey?: string;
	sourceEventId: string;
	relayVersion: string;
	platform?: Platform;
};

/**
 * Tells whether a request, or the `cf.request` of a Lambda@Edge event, comes from an AI agent. Reads headers only and never waits on the network.
 * Every 12 hours it starts one background fetch of the newest AI bot list, unless `rules` is `"bundled"`.
 */
export function isAgent(
	request: Request | CloudFrontRequest,
	options: IsAgentOptions = {},
): boolean {
	startRulesRefresh(options);
	try {
		const { headers, ip } = toRelayRequest(request);
		return decide({
			headers: readCappedHeaders(headers),
			ip,
			useBundled: options.rules === "bundled",
		});
	} catch {
		return false;
	}
}

function startRulesRefresh(options: IsAgentOptions): void {
	try {
		if (options.rules === "bundled") {
			return;
		}
		const apiUrl = resolveApiUrl(options);
		const work = apiUrl ? refreshRules(apiUrl) : null;
		if (work) {
			schedule(work, options.waitUntil);
		}
	} catch {}
}

/**
 * Posts one event for this request to WaniWani after the response.
 * Sends nothing when no key is set. Never throws, never rejects and never touches the request.
 * The promise settles when the post is done, so Lambda@Edge, which has no `waitUntil`, awaits it.
 */
export function recordAgentVisit(
	request: Request | CloudFrontRequest,
	options: RelayOptions = {},
): Promise<void> {
	try {
		const key = readKey(options.key);
		if (!key) {
			return Promise.resolve();
		}
		const apiUrl = resolveApiUrl(options);
		if (!apiUrl) {
			return Promise.resolve();
		}
		const omitted = omitSet(options.omit);
		const {
			url: requestUrl,
			method,
			headers: requestHeaders,
			ip,
			platform,
		} = toRelayRequest(request);
		if (requestUrl === null) {
			return Promise.resolve();
		}
		const capped = readCappedHeaders(requestHeaders);

		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(capped)) {
			if (!omitted.has(name)) {
				headers[name] = value;
			}
		}
		const url = new URL(requestUrl);
		const record: AgentVisitRecord = {
			occurredAt: new Date().toISOString(),
			method,
			host: url.hostname,
			path: url.pathname + url.search,
			headers,
			sourceEventId: crypto.randomUUID(),
			relayVersion: RELAY_VERSION,
		};
		if (capped["user-agent"] !== undefined && !omitted.has("user-agent")) {
			record.userAgent = capped["user-agent"];
		}
		if (capped.referer !== undefined && !omitted.has("referer")) {
			record.referer = capped.referer;
		}
		if (platform !== undefined) {
			record.platform = platform;
		}

		const policy: PostPolicy =
			platform === "cloudfront"
				? { timeoutMs: settings.cloudFrontTimeoutMs, retry: false }
				: { timeoutMs: settings.requestTimeoutMs, retry: true };
		const ingestUrl = `${apiUrl}/api/v2/agent-traffic/ingest/middleware/${key.ingestToken}`;
		const withMatchKey = async () => {
			if (ip !== null && !omitted.has("matchkey")) {
				record.matchKey = await deriveMatchKey(key.orgKey, ip).catch(
					() => undefined,
				);
			}
			await postEvent(
				ingestUrl,
				JSON.stringify({ requests: [record] }),
				policy,
			);
		};
		return schedule(withMatchKey(), options.waitUntil);
	} catch {
		return Promise.resolve();
	}
}

/**
 * The stored agent page for this request, when its site lists the path and the user agent acts for a user. Otherwise null, and the caller serves the origin.
 * Never throws and never rejects.
 */
export async function serveAgentPage(
	request: Request,
	options: ServeAgentPageOptions = {},
): Promise<Response | null> {
	try {
		const key = readKey(options.key);
		if (!key) {
			return null;
		}
		const apiUrl = resolveApiUrl(options);
		if (!apiUrl || isCloudFrontRequest(request)) {
			return null;
		}
		const method = request.method.toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			return null;
		}
		if (request.headers.has("x-waniwani-render")) {
			return null;
		}
		const rules = await loadSiteRules(apiUrl, key.ingestToken, (work) =>
			schedule(work, undefined),
		);
		if (!rules) {
			return null;
		}
		const url = new URL(request.url);
		const site = rules.sites.find((entry) => entry.hostname === url.hostname);
		if (!site?.agentPages.enabled) {
			return null;
		}
		const path = normalizePath(url.pathname);
		if (!matchesPath(path, site.agentPages.paths)) {
			return null;
		}
		const userAgent = (request.headers.get("user-agent") ?? "").toLowerCase();
		if (!rules.userAgentTokens.some((token) => userAgent.includes(token))) {
			return null;
		}
		const page = await fetchAgentPage(rules, url.hostname, path);
		if (!page) {
			return null;
		}
		return new Response(method === "HEAD" ? null : page.body, {
			status: 200,
			headers: {
				"content-type": page.contentType,
				"x-waniwani-agent-page": "hit",
				"cache-control": "private, no-store",
				vary: "user-agent, accept",
			},
		});
	} catch {
		return null;
	}
}

let warnedRegion = false;

function resolveApiUrl(options: IsAgentOptions): string | null {
	if (options.apiUrl !== undefined) {
		return options.apiUrl.replace(/\/+$/, "");
	}
	const region = options.region ?? "us";
	if (Object.hasOwn(settings.apiUrls, region)) {
		return settings.apiUrls[region];
	}
	if (!warnedRegion) {
		warnedRegion = true;
		console.warn(
			`[@waniwani/relay] Unknown region ${JSON.stringify(region)}, so no agent visits are recorded. Use "us" or "eu".`,
		);
	}
	return null;
}

function omitSet(omit: Array<string> | undefined): Set<string> {
	const names = new Set((omit ?? []).map((name) => name.toLowerCase()));
	if (names.has("useragent")) {
		names.add("user-agent");
	}
	return names;
}

function schedule(
	work: Promise<unknown>,
	waitUntil: RelayOptions["waitUntil"],
): Promise<void> {
	const settled = work.then(
		() => undefined,
		() => undefined,
	);
	try {
		(waitUntil ?? vercelWaitUntil())?.(settled);
	} catch {}
	return settled;
}
