import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest } from "../src/index";
import {
	API_URL,
	freshRelay,
	type Handler,
	hang,
	INGEST_TOKEN,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/rules`;
const BOT_LIST_URL = `${API_URL}/api/v2/agent-traffic/rules`;
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const SHOP = "shop.example.com";
const ORIGIN_HOST = "origin-bucket.s3.amazonaws.com";
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;
const SHOP_PRICING_URL = `${PAGES_URL}/${SHOP}/pricing`;
const PREFIX = "/__waniwani-agent/";

const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CLAUDEBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CLAUDE_USER_UA = "Claude-User/1.0 (+https://anthropic.com)";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PERSON_IP = "198.51.100.23";

type Site = {
	hostname: string;
	blockedUserAgentTokens: string[];
	agentPages: { enabled: boolean; paths: string[] };
};

const site = (overrides: Partial<Site> = {}): Site => ({
	hostname: HOST,
	blockedUserAgentTokens: ["gptbot"],
	agentPages: { enabled: true, paths: ["/pricing", "/docs/*"] },
	...overrides,
});

function siteRules(
	sites: Site[] = [site()],
	overrides: Record<string, unknown> = {},
) {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens: ["chatgpt-user", "claude-user"],
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 16,
		sites,
		...overrides,
	};
}

const rulesAnswer =
	(data: unknown = siteRules()): Handler =>
	() =>
		Response.json({ success: true, message: "success", data });

const page =
	(
		body: BodyInit = "# Pricing",
		contentType = "text/markdown; charset=utf-8",
	): Handler =>
	() =>
		new Response(body, { headers: { "content-type": contentType } });

const header = (key: string, value: string) => [{ key, value }];

const marked = (path = "/pricing", host = HOST) =>
	`${PREFIX}${encodeURIComponent(host)}${path}`;

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** A viewer-request event as the client sent it. */
function viewerRequest(
	init: {
		userAgent?: string;
		method?: string;
		uri?: string;
		host?: string;
		querystring?: string;
		headers?: CloudFrontRequest["headers"];
	} = {},
): CloudFrontRequest {
	return {
		clientIp: PERSON_IP,
		method: init.method ?? "GET",
		uri: init.uri ?? "/pricing",
		querystring: init.querystring ?? "",
		headers: {
			host: header("Host", init.host ?? HOST),
			"user-agent": header("User-Agent", init.userAgent ?? CHATGPT_USER_UA),
			...init.headers,
		},
	};
}

/** An origin-request event: CloudFront has replaced the viewer `Host` and `User-Agent`. */
function originRequest(
	init: {
		method?: string;
		uri?: string;
		headers?: CloudFrontRequest["headers"];
	} = {},
): CloudFrontRequest {
	return {
		clientIp: PERSON_IP,
		method: init.method ?? "GET",
		uri: init.uri ?? marked(),
		querystring: "",
		headers: {
			host: header("Host", ORIGIN_HOST),
			"user-agent": header("User-Agent", "Amazon CloudFront"),
			...init.headers,
		},
	};
}

/** What CloudFront does between viewer-request and origin-request. */
function toOrigin(viewer: CloudFrontRequest): CloudFrontRequest {
	return {
		...viewer,
		headers: {
			...viewer.headers,
			host: header("Host", ORIGIN_HOST),
			"user-agent": header("User-Agent", "Amazon CloudFront"),
		},
	};
}

async function setup(routes: Record<string, Handler> = {}) {
	const relay = await freshRelay();
	const stub = stubFetch({
		[RULES_URL]: rulesAnswer(),
		[PRICING_URL]: page(),
		...routes,
	});
	const options = { key: KEY, apiUrl: API_URL };
	const view = (request: CloudFrontRequest) =>
		relay.handleViewerRequest(request, options);
	const serve = (request: CloudFrontRequest = originRequest()) =>
		relay.serveAgentPage(request, options);
	const urls = () =>
		stub.calls.map((call) => call.url).filter((url) => url !== BOT_LIST_URL);
	return { ...stub, relay, view, serve, urls };
}

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("handleViewerRequest: marking", () => {
	it("marks a user-acting agent on a listed path with its host and returns null", async () => {
		const { view, urls } = await setup();
		const request = viewerRequest();
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe(`${PREFIX}${HOST}/pricing`);
		expect(urls()).toEqual([RULES_URL]);
	});

	it("marks with the hostname of the host header, lowercased and without its port", async () => {
		const { view } = await setup();
		const request = viewerRequest({ host: "WWW.Example.COM:8443" });
		await view(request);
		expect(request.uri).toBe(marked());
	});

	it("marks a path under a folder entry and the folder itself", async () => {
		const { view } = await setup();
		for (const uri of ["/docs", "/docs/", "/docs/a/b"]) {
			const request = viewerRequest({ userAgent: CLAUDE_USER_UA, uri });
			await view(request);
			expect(request.uri).toBe(marked(uri));
		}
	});

	it("keeps the query string and the headers as they are", async () => {
		const { view } = await setup();
		const request = viewerRequest({
			querystring: "a=1&b=%20x",
			headers: { cookie: header("Cookie", "a=1") },
		});
		await view(request);
		expect(request.uri).toBe(marked());
		expect(request.querystring).toBe("a=1&b=%20x");
		expect(request.headers).toEqual({
			host: header("Host", HOST),
			"user-agent": header("User-Agent", CHATGPT_USER_UA),
			cookie: header("Cookie", "a=1"),
		});
	});

	it("marks HEAD the same as GET", async () => {
		const { view } = await setup();
		const request = viewerRequest({ method: "HEAD" });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe(marked());
	});
});

describe("handleViewerRequest: requests that stay unmarked", () => {
	it("gives a training crawler and a person the same uri", async () => {
		const { view, urls } = await setup();
		const crawler = viewerRequest({ userAgent: CLAUDEBOT_UA });
		expect(await view(crawler)).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
		const person = viewerRequest({ userAgent: CHROME_UA });
		expect(await view(person)).toBeNull();
		expect(crawler.uri).toBe("/pricing");
		expect(person.uri).toBe("/pricing");
	});

	it("never loads the site rules for a person", async () => {
		const { view, urls } = await setup();
		await view(viewerRequest({ userAgent: CHROME_UA }));
		await view(
			viewerRequest({
				userAgent: CHROME_UA,
				headers: {
					"x-waniwani-agent": header("X-WaniWani-Agent", CHATGPT_USER_UA),
				},
			}),
		);
		expect(urls()).toEqual([]);
	});

	it("leaves a user-acting agent on an unlisted path unmarked", async () => {
		const { view } = await setup();
		const request = viewerRequest({ uri: "/blog/post" });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/blog/post");
	});

	it("leaves a path that only shares a folder's prefix unmarked", async () => {
		const { view } = await setup();
		const request = viewerRequest({ uri: "/docsx" });
		await view(request);
		expect(request.uri).toBe("/docsx");
	});

	it("leaves a user-acting agent unmarked on a site with agent pages off", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ agentPages: { enabled: false, paths: ["/*"] } })]),
			),
		});
		const request = viewerRequest();
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("leaves the renderer unmarked", async () => {
		const { view } = await setup();
		const request = viewerRequest({
			headers: { "x-waniwani-render": header("X-WaniWani-Render", "1") },
		});
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("leaves a POST from a user-acting agent unmarked without loading rules", async () => {
		const { view, urls } = await setup();
		const request = viewerRequest({ method: "POST" });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
		expect(urls()).toEqual([]);
	});

	it("leaves an agent on a host missing from the rules unmarked", async () => {
		const { view } = await setup();
		const request = viewerRequest({ host: "other.example.org" });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("returns null without a key", async () => {
		const { relay, urls } = await setup();
		const request = viewerRequest();
		expect(
			await relay.handleViewerRequest(request, { apiUrl: API_URL }),
		).toBeNull();
		expect(request.uri).toBe("/pricing");
		expect(urls()).toEqual([]);
	});
});

describe("handleViewerRequest: blocking", () => {
	it("answers a blocked agent with a 403 result before any page fetch", async () => {
		const { view, urls } = await setup();
		const result = await view(viewerRequest({ userAgent: GPTBOT_UA }));
		expect(result?.status).toBe("403");
		expect(result?.body).toBe("Forbidden");
		expect(result?.headers["x-waniwani-blocked"]?.[0]?.value).toBe("1");
		expect(result?.headers["cache-control"]?.[0]?.value).toBe(
			"private, no-store",
		);
		expect(result?.headers.vary?.[0]?.value).toBe("user-agent");
		for (const [name, entries] of Object.entries(result?.headers ?? {})) {
			expect(entries[0]?.key.toLowerCase()).toBe(name);
		}
		expect(urls()).toEqual([RULES_URL]);
	});

	it("blocks a blocked agent that sends the render header", async () => {
		const { view } = await setup();
		const result = await view(
			viewerRequest({
				userAgent: GPTBOT_UA,
				headers: { "x-waniwani-render": header("X-WaniWani-Render", "1") },
			}),
		);
		expect(result?.status).toBe("403");
	});

	it("answers HEAD from a blocked agent with no body field", async () => {
		const { view } = await setup();
		const result = await view(
			viewerRequest({ userAgent: GPTBOT_UA, method: "HEAD" }),
		);
		expect(result?.status).toBe("403");
		expect(result !== null && "body" in result).toBe(false);
	});

	it("blocks on an unlisted path of a site with agent pages off", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ agentPages: { enabled: false, paths: [] } })]),
			),
		});
		const result = await view(
			viewerRequest({ userAgent: GPTBOT_UA, uri: "/blog" }),
		);
		expect(result?.status).toBe("403");
	});

	it("blocks a user-acting agent whose token the site blocks", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ blockedUserAgentTokens: ["ChatGPT-User"] })]),
			),
		});
		const request = viewerRequest();
		expect((await view(request))?.status).toBe("403");
		expect(request.uri).toBe("/pricing");
	});

	it("lets a POST from a blocked agent through without loading rules", async () => {
		const { view, urls } = await setup();
		expect(
			await view(viewerRequest({ userAgent: GPTBOT_UA, method: "POST" })),
		).toBeNull();
		expect(urls()).toEqual([]);
	});

	it("never blocks a person, even when a blocked token matches the browser", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ blockedUserAgentTokens: ["mozilla"] })]),
			),
		});
		expect(await view(viewerRequest({ userAgent: CHROME_UA }))).toBeNull();
	});
});

describe("handleViewerRequest: two hosts on one distribution", () => {
	const twoSites = siteRules([
		site(),
		site({
			hostname: SHOP,
			blockedUserAgentTokens: ["claude-user"],
			agentPages: { enabled: false, paths: ["/pricing"] },
		}),
	]);

	it("applies each host's own rules", async () => {
		const { view, urls } = await setup({ [RULES_URL]: rulesAnswer(twoSites) });

		const shopGptBot = viewerRequest({ host: SHOP, userAgent: GPTBOT_UA });
		expect(await view(shopGptBot)).toBeNull();
		expect(shopGptBot.uri).toBe("/pricing");

		const shopClaude = viewerRequest({ host: SHOP, userAgent: CLAUDE_USER_UA });
		expect((await view(shopClaude))?.status).toBe("403");

		const shopChatGpt = viewerRequest({ host: SHOP });
		expect(await view(shopChatGpt)).toBeNull();
		expect(shopChatGpt.uri).toBe("/pricing");

		const mainClaude = viewerRequest({ userAgent: CLAUDE_USER_UA });
		expect(await view(mainClaude)).toBeNull();
		expect(mainClaude.uri).toBe(marked());

		expect((await view(viewerRequest({ userAgent: GPTBOT_UA })))?.status).toBe(
			"403",
		);
		expect(urls()).toEqual([RULES_URL]);
	});

	it("marks each host with its own name so the cache keys differ", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([
					site(),
					site({ hostname: SHOP, blockedUserAgentTokens: [] }),
				]),
			),
		});
		const main = viewerRequest();
		const shop = viewerRequest({ host: SHOP });
		await view(main);
		await view(shop);
		expect(main.uri).toBe(marked("/pricing", HOST));
		expect(shop.uri).toBe(marked("/pricing", SHOP));
	});
});

describe("handleViewerRequest: a forged prefix", () => {
	it("strips a prefix a person sent", async () => {
		const { view } = await setup();
		const request = viewerRequest({ userAgent: CHROME_UA, uri: marked() });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("strips a nested prefix", async () => {
		const { view } = await setup();
		const request = viewerRequest({
			userAgent: CHROME_UA,
			uri: `${PREFIX}x${marked("/pricing", "evil.example")}`,
		});
		await view(request);
		expect(request.uri).toBe("/pricing");
	});

	it("strips a prefix with no path after it down to the root", async () => {
		const { view } = await setup();
		const request = viewerRequest({
			userAgent: CHROME_UA,
			uri: `${PREFIX}anything`,
		});
		await view(request);
		expect(request.uri).toBe("/");
	});

	it("leaves a path that only looks like the prefix alone", async () => {
		const { view } = await setup();
		const request = viewerRequest({
			userAgent: CHROME_UA,
			uri: "/__waniwani-agentx/pricing",
		});
		await view(request);
		expect(request.uri).toBe("/__waniwani-agentx/pricing");
	});

	it("replaces a prefix an agent forged for another host with the real host", async () => {
		const { view } = await setup();
		const request = viewerRequest({ uri: marked("/pricing", SHOP) });
		await view(request);
		expect(request.uri).toBe(marked("/pricing", HOST));
	});

	it("strips the prefix for a POST and for a blocked agent", async () => {
		const { view } = await setup();
		const post = viewerRequest({ method: "POST", uri: marked() });
		await view(post);
		expect(post.uri).toBe("/pricing");
		const blocked = viewerRequest({ userAgent: GPTBOT_UA, uri: marked() });
		expect((await view(blocked))?.status).toBe("403");
		expect(blocked.uri).toBe("/pricing");
	});

	it.each([
		["a 500", () => new Response(null, { status: 500 })],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
		["a timeout", hang],
	])(
		"returns null with the prefix stripped when the rules fail with %s",
		async (_name, handler: Handler) => {
			const { view } = await setup({ [RULES_URL]: handler });
			for (const userAgent of [CHATGPT_USER_UA, GPTBOT_UA]) {
				const request = viewerRequest({ userAgent, uri: marked() });
				expect(await view(request)).toBeNull();
				expect(request.uri).toBe("/pricing");
			}
		},
	);

	it("strips the prefix when the host header is missing", async () => {
		const { view } = await setup();
		const request = viewerRequest({ uri: marked() });
		Reflect.deleteProperty(request.headers, "host");
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});
});

describe("handleViewerRequest: the uri limit", () => {
	async function boundary() {
		const ctx = await setup();
		const limit = ctx.relay.settings.cloudFrontMaxUriBytes;
		const overhead = byteLength(marked("/docs/"));
		return { ...ctx, limit, overhead };
	}

	it("marks a uri whose marked form is exactly the limit", async () => {
		const { view, limit, overhead } = await boundary();
		const uri = `/docs/${"a".repeat(limit - overhead)}`;
		const request = viewerRequest({ uri });
		await view(request);
		expect(byteLength(request.uri)).toBe(limit);
		expect(request.uri).toBe(marked(uri));
	});

	it("leaves a uri unmarked when its marked form is one byte over", async () => {
		const { view, limit, overhead } = await boundary();
		const uri = `/docs/${"a".repeat(limit - overhead + 1)}`;
		const request = viewerRequest({ uri });
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe(uri);
	});

	it("counts bytes, not characters", async () => {
		const { view, limit, overhead } = await boundary();
		const uri = `/docs/${"é".repeat(Math.ceil((limit - overhead + 1) / 2))}`;
		expect(marked(uri).length).toBeLessThanOrEqual(limit);
		expect(byteLength(marked(uri))).toBeGreaterThan(limit);
		const request = viewerRequest({ uri });
		await view(request);
		expect(request.uri).toBe(uri);
	});
});

describe("handleViewerRequest: never throws", () => {
	it("returns null for a request with no headers and strips the prefix", async () => {
		const { view } = await setup();
		const request = viewerRequest({ uri: marked() });
		Reflect.deleteProperty(request, "headers");
		await expect(view(request)).resolves.toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("returns null when the headers cannot be read", async () => {
		const { view } = await setup();
		const request = viewerRequest();
		Object.defineProperty(request, "headers", {
			get() {
				throw new Error("boom");
			},
		});
		await expect(view(request)).resolves.toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("returns null for rules that are not the expected shape", async () => {
		const { view } = await setup({ [RULES_URL]: rulesAnswer({ version: 2 }) });
		const request = viewerRequest();
		expect(await view(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});
});

describe("serveAgentPage on CloudFront: an unmarked request", () => {
	it("returns null before reading the key or the rules", async () => {
		const { serve, fetchMock } = await setup();
		const request = originRequest({
			uri: "/pricing",
			headers: { "user-agent": header("User-Agent", CHATGPT_USER_UA) },
		});
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never answers 403 to an unmarked blocked agent", async () => {
		const { serve, fetchMock } = await setup();
		const request = originRequest({
			uri: "/pricing",
			headers: { "user-agent": header("User-Agent", GPTBOT_UA) },
		});
		expect(await serve(request)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage on CloudFront: a marked request", () => {
	it("serves the page of the host in the mark and restores the path", async () => {
		const { serve, urls } = await setup();
		const request = originRequest();
		const result = await serve(request);
		expect(result?.status).toBe("200");
		expect(result?.body).toBe("# Pricing");
		expect(result?.headers).toEqual({
			"content-type": [
				{ key: expect.any(String), value: "text/markdown; charset=utf-8" },
			],
			"x-waniwani-agent-page": [{ key: expect.any(String), value: "hit" }],
			"cache-control": [
				{ key: expect.any(String), value: "private, no-store" },
			],
			vary: [{ key: expect.any(String), value: "user-agent, accept" }],
		});
		expect(request.uri).toBe("/pricing");
		expect(urls()).toEqual([RULES_URL, PRICING_URL]);
	});

	it("reads no user agent and never answers 403", async () => {
		const { serve } = await setup();
		const result = await serve(
			originRequest({
				headers: { "user-agent": header("User-Agent", GPTBOT_UA) },
			}),
		);
		expect(result?.status).toBe("200");
	});

	it("decodes an encoded host with a port and capitals", async () => {
		const { serve, urls } = await setup();
		const result = await serve(
			originRequest({ uri: marked("/pricing", "WWW.Example.COM:8443") }),
		);
		expect(result?.status).toBe("200");
		expect(urls()).toContain(PRICING_URL);
	});

	it("answers HEAD with the headers and no body field", async () => {
		const { serve } = await setup();
		const result = await serve(originRequest({ method: "HEAD" }));
		expect(result?.status).toBe("200");
		expect(result !== null && "body" in result).toBe(false);
	});

	it("returns null for a marked POST and restores the path", async () => {
		const { serve } = await setup();
		const request = originRequest({ method: "POST" });
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("restores the path and returns null for a host missing from the rules", async () => {
		const { serve, urls } = await setup();
		const request = originRequest({ uri: marked("/pricing", "other.org") });
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
		expect(urls()).toEqual([RULES_URL]);
	});

	it("restores the root for a prefix with no host and no path", async () => {
		const { serve } = await setup();
		const request = originRequest({ uri: PREFIX });
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/");
	});

	it.each([
		`${PREFIX}%E0%A4%A/pricing`,
		`${PREFIX}${encodeURIComponent("www.example.com/x")}/pricing`,
		`${PREFIX}${encodeURIComponent("user@www.example.com")}/pricing`,
	])(
		"restores the path and fetches nothing for the malformed host in %s",
		async (uri) => {
			const { serve, fetchMock } = await setup();
			const request = originRequest({ uri });
			expect(await serve(request)).toBeNull();
			expect(request.uri).toBe("/pricing");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("restores the path without a key", async () => {
		const { relay } = await setup();
		const request = originRequest();
		expect(await relay.serveAgentPage(request, { apiUrl: API_URL })).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("leaves the query string as it is", async () => {
		const { serve } = await setup();
		const request = { ...originRequest(), querystring: "a=1&b=%20x" };
		await serve(request);
		expect(request.querystring).toBe("a=1&b=%20x");
		expect(request.uri).toBe("/pricing");
	});

	it("serves the page without reading any header", async () => {
		const { serve } = await setup();
		const request = originRequest();
		Object.defineProperty(request, "headers", {
			get() {
				throw new Error("boom");
			},
		});
		expect((await serve(request))?.status).toBe("200");
		expect(request.uri).toBe("/pricing");
	});

	it("returns null when reading the uri throws", async () => {
		const { serve } = await setup();
		const request = originRequest();
		Object.defineProperty(request, "uri", {
			get() {
				throw new Error("boom");
			},
		});
		await expect(serve(request)).resolves.toBeNull();
	});
});

describe("serveAgentPage on CloudFront: failures return null with the path restored", () => {
	const cases: Array<[string, Record<string, Handler>]> = [
		[
			"the rules answer a 500",
			{ [RULES_URL]: () => new Response(null, { status: 500 }) },
		],
		["the rules time out", { [RULES_URL]: hang }],
		[
			"the page is a 404",
			{ [PRICING_URL]: () => new Response("x", { status: 404 }) },
		],
		[
			"the page is not text",
			{ [PRICING_URL]: page('{"a":1}', "application/json") },
		],
		["the page headers miss their deadline", { [PRICING_URL]: hang }],
		["the page is over the rules cap", { [PRICING_URL]: page("x".repeat(17)) }],
	];

	it.each(cases)("when %s", async (_name, routes) => {
		const { serve } = await setup(routes);
		const request = originRequest();
		const started = Date.now();
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("serveAgentPage on CloudFront: the response size limit", () => {
	async function bigSetup(size: (limit: number) => string) {
		const probe = await freshRelay();
		const limit = probe.settings.cloudFrontMaxBodyBytes;
		const body = size(limit);
		const ctx = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site()], { maxBodyBytes: 4_000_000 }),
			),
			[PRICING_URL]: page(body),
		});
		return { ...ctx, limit, body };
	}

	it("serves a body of exactly the limit", async () => {
		const { serve, limit } = await bigSetup((limit) => "x".repeat(limit));
		const result = await serve();
		expect(result?.status).toBe("200");
		expect(result?.body?.length).toBe(limit);
	});

	it("returns null and restores the path for a body one byte over", async () => {
		const { serve } = await bigSetup((limit) => "x".repeat(limit + 1));
		const request = originRequest();
		expect(await serve(request)).toBeNull();
		expect(request.uri).toBe("/pricing");
	});

	it("counts the bytes of the body, not its characters", async () => {
		const { serve, limit, body } = await bigSetup((limit) =>
			"é".repeat(Math.floor(limit / 2) + 1),
		);
		expect(body.length).toBeLessThan(limit);
		expect(await serve()).toBeNull();
	});

	it("still answers HEAD for a page over the limit", async () => {
		const { serve } = await bigSetup((limit) => "x".repeat(limit + 1));
		const result = await serve(originRequest({ method: "HEAD" }));
		expect(result?.status).toBe("200");
	});
});

describe("handleViewerRequest then serveAgentPage", () => {
	async function roundTrip(
		viewer: CloudFrontRequest,
		routes: Record<string, Handler> = {},
	) {
		const ctx = await setup(routes);
		const atViewer = await ctx.view(viewer);
		const origin = toOrigin(viewer);
		const result = atViewer ? null : await ctx.serve(origin);
		return { ...ctx, atViewer, result, origin };
	}

	it("serves the page to a user-acting agent", async () => {
		const { atViewer, result, origin } = await roundTrip(viewerRequest());
		expect(atViewer).toBeNull();
		expect(result?.status).toBe("200");
		expect(result?.body).toBe("# Pricing");
		expect(origin.uri).toBe("/pricing");
	});

	it("restores the path and query for the origin when the page is missing", async () => {
		const { result, origin, urls } = await roundTrip(
			viewerRequest({ uri: "/docs/guide", querystring: "page=2" }),
		);
		expect(result).toBeNull();
		expect(origin.uri).toBe("/docs/guide");
		expect(origin.querystring).toBe("page=2");
		expect(urls()).toEqual([RULES_URL, `${PAGES_URL}/${HOST}/docs/guide`]);
	});

	it("restores a path holding percent-encoded characters unchanged", async () => {
		const { origin } = await roundTrip(
			viewerRequest({ uri: "/docs/caf%C3%A9%20menu" }),
		);
		expect(origin.uri).toBe("/docs/caf%C3%A9%20menu");
	});

	it("answers a blocked agent at viewer-request", async () => {
		const { atViewer, urls } = await roundTrip(
			viewerRequest({ userAgent: GPTBOT_UA }),
		);
		expect(atViewer?.status).toBe("403");
		expect(urls()).toEqual([RULES_URL]);
	});

	it("gives a person who forges the prefix the origin at the real path", async () => {
		for (const forged of [marked(), marked("/pricing", SHOP)]) {
			const { result, origin, urls } = await roundTrip(
				viewerRequest({ userAgent: CHROME_UA, uri: forged }),
			);
			expect(result).toBeNull();
			expect(origin.uri).toBe("/pricing");
			expect(urls()).toEqual([]);
		}
	});

	it("gives a crawler the origin with no page fetch", async () => {
		const { result, origin, urls } = await roundTrip(
			viewerRequest({ userAgent: CLAUDEBOT_UA }),
		);
		expect(result).toBeNull();
		expect(origin.uri).toBe("/pricing");
		expect(urls()).toEqual([RULES_URL]);
	});

	it("serves each host on one distribution its own page", async () => {
		const ctx = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([
					site(),
					site({ hostname: SHOP, blockedUserAgentTokens: [] }),
				]),
			),
			[SHOP_PRICING_URL]: page("# Shop"),
		});
		const main = viewerRequest();
		const shop = viewerRequest({ host: SHOP });
		await ctx.view(main);
		await ctx.view(shop);
		expect((await ctx.serve(toOrigin(main)))?.body).toBe("# Pricing");
		expect((await ctx.serve(toOrigin(shop)))?.body).toBe("# Shop");
	});
});
