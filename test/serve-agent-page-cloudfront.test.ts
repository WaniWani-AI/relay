import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest, ServeAgentPageOptions } from "../src/index";
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
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const ORIGIN_HOST = "origin-bucket.s3.amazonaws.com";
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;

const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PERSON_IP = "198.51.100.23";

function siteRules(
	site: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens: ["chatgpt-user", "claude-user"],
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 16,
		sites: [
			{
				hostname: HOST,
				blockedUserAgentTokens: ["gptbot"],
				agentPages: { enabled: true, paths: ["/pricing"] },
				...site,
			},
		],
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

function bytesStream(
	chunks: Uint8Array[],
	end = true,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			if (end) {
				controller.close();
			}
		},
	});
}

const header = (key: string, value: string) => [{ key, value }];

/** An origin-request event: CloudFront has replaced the viewer `Host` and `User-Agent`. */
function originRequest(
	init: {
		agent?: string | null;
		method?: string;
		uri?: string;
		host?: string;
		headers?: CloudFrontRequest["headers"];
	} = {},
): CloudFrontRequest {
	const agent = init.agent === undefined ? CHATGPT_USER_UA : init.agent;
	return {
		clientIp: PERSON_IP,
		method: init.method ?? "GET",
		uri: init.uri ?? "/pricing",
		querystring: "",
		headers: {
			host: header("Host", init.host ?? ORIGIN_HOST),
			"user-agent": header("User-Agent", "Amazon CloudFront"),
			...(agent === null
				? {}
				: { "x-waniwani-agent": header("X-WaniWani-Agent", agent) }),
			...init.headers,
		},
	};
}

/** A viewer-request event as the client sent it. */
function viewerRequest(
	userAgent: string,
	extra: CloudFrontRequest["headers"] = {},
): CloudFrontRequest {
	return {
		clientIp: PERSON_IP,
		method: "GET",
		uri: "/pricing",
		querystring: "",
		headers: {
			host: header("Host", HOST),
			"user-agent": header("User-Agent", userAgent),
			...extra,
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
	const serve = (
		request: CloudFrontRequest = originRequest(),
		options: ServeAgentPageOptions = { hostname: HOST },
	) => relay.serveAgentPage(request, { key: KEY, apiUrl: API_URL, ...options });
	const urls = () => stub.calls.map((call) => call.url);
	return { ...stub, relay, serve, urls };
}

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("serveAgentPage on CloudFront: a hit", () => {
	it("returns a CloudFront result with the page as text", async () => {
		const { serve } = await setup();
		const result = await serve();
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
	});

	it("gives each header a key that names the same header", async () => {
		const { serve } = await setup();
		const result = await serve();
		for (const [name, entries] of Object.entries(result?.headers ?? {})) {
			expect(entries).toHaveLength(1);
			expect(entries[0]?.key.toLowerCase()).toBe(name);
		}
	});

	it("fetches the page of the site hostname, never the origin host", async () => {
		const { serve, urls } = await setup();
		await serve();
		expect(urls()).toContain(PRICING_URL);
		expect(urls().some((url) => url.includes(ORIGIN_HOST))).toBe(false);
	});

	it("answers HEAD with the headers and no body field", async () => {
		const { serve } = await setup();
		const result = await serve(originRequest({ method: "HEAD" }));
		expect(result?.status).toBe("200");
		expect(result?.headers["x-waniwani-agent-page"]?.[0]?.value).toBe("hit");
		expect(result !== null && "body" in result).toBe(false);
	});

	it("decodes a UTF-8 body split inside a character", async () => {
		const bytes = new TextEncoder().encode("# Prix €5");
		const euro = bytes.indexOf(0xe2);
		const { serve } = await setup({
			[PRICING_URL]: () =>
				new Response(
					bytesStream([bytes.slice(0, euro + 1), bytes.slice(euro + 1)]),
					{ headers: { "content-type": "text/markdown; charset=utf-8" } },
				),
		});
		expect((await serve())?.body).toBe("# Prix €5");
	});

	it("serves a body of exactly the cap", async () => {
		const { serve } = await setup({ [PRICING_URL]: page("x".repeat(16)) });
		expect((await serve())?.body).toBe("x".repeat(16));
	});

	it("drops the trailing slash from the uri", async () => {
		const { serve, urls } = await setup();
		expect((await serve(originRequest({ uri: "/pricing/" })))?.status).toBe(
			"200",
		);
		expect(urls()).toContain(PRICING_URL);
	});
});

describe("serveAgentPage on CloudFront: the hostname", () => {
	it("prefers the hostname option over the host header", async () => {
		const { serve } = await setup();
		expect(
			(await serve(originRequest({ host: "elsewhere.example.org" })))?.status,
		).toBe("200");
		expect(
			await serve(originRequest({ host: HOST }), {
				hostname: "elsewhere.example.org",
			}),
		).toBeNull();
	});

	it("lowercases the hostname option and drops its port", async () => {
		const { serve, urls } = await setup();
		const result = await serve(originRequest(), {
			hostname: "WWW.Example.COM:8443",
		});
		expect(result?.status).toBe("200");
		expect(urls()).toContain(PRICING_URL);
	});

	it("falls back to the host header, lowercased and without its port", async () => {
		const { serve } = await setup();
		const result = await serve(
			originRequest({ host: "WWW.EXAMPLE.COM:8443" }),
			{},
		);
		expect(result?.status).toBe("200");
	});

	it("returns null without a hostname option or a host header", async () => {
		const { serve, fetchMock } = await setup();
		const request = originRequest();
		Reflect.deleteProperty(request.headers, "host");
		expect(await serve(request, {})).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"www.example.com/pricing",
		"user@www.example.com",
		"www.example.com?x",
	])("returns null for a malformed hostname %s", async (hostname) => {
		const { serve } = await setup();
		expect(await serve(originRequest(), { hostname })).toBeNull();
	});
});

describe("serveAgentPage on CloudFront: the user agent", () => {
	it("returns null when x-waniwani-agent is missing, whatever the user-agent header says", async () => {
		const { serve, fetchMock } = await setup();
		const request = originRequest({
			agent: null,
			headers: { "user-agent": header("User-Agent", CHATGPT_USER_UA) },
		});
		expect(await serve(request)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores a user-agent header holding a blocked token", async () => {
		const { serve } = await setup();
		const request = originRequest({
			agent: CHROME_UA,
			headers: { "user-agent": header("User-Agent", GPTBOT_UA) },
		});
		expect(await serve(request)).toBeNull();
	});

	it("returns null for a browser user agent", async () => {
		const { serve } = await setup();
		expect(await serve(originRequest({ agent: CHROME_UA }))).toBeNull();
	});
});

describe("serveAgentPage on CloudFront: blocking", () => {
	it("answers a blocked agent with a 403 result", async () => {
		const { serve, urls } = await setup();
		const result = await serve(originRequest({ agent: GPTBOT_UA }));
		expect(result?.status).toBe("403");
		expect(result?.body).toBe("Forbidden");
		expect(result?.headers["x-waniwani-blocked"]?.[0]?.value).toBe("1");
		expect(result?.headers["cache-control"]?.[0]?.value).toBe(
			"private, no-store",
		);
		expect(result?.headers.vary?.[0]?.value).toBe("user-agent");
		expect(urls()).toEqual([RULES_URL]);
	});

	it("answers HEAD from a blocked agent with no body field", async () => {
		const { serve } = await setup();
		const result = await serve(
			originRequest({ agent: GPTBOT_UA, method: "HEAD" }),
		);
		expect(result?.status).toBe("403");
		expect(result !== null && "body" in result).toBe(false);
	});

	it("blocks with agent pages off", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules({ agentPages: { enabled: false, paths: [] } }),
			),
		});
		expect((await serve(originRequest({ agent: GPTBOT_UA })))?.status).toBe(
			"403",
		);
	});

	it("does not block on another hostname", async () => {
		const { serve } = await setup();
		expect(
			await serve(originRequest({ agent: GPTBOT_UA }), {
				hostname: "shop.example.com",
			}),
		).toBeNull();
	});

	it("lets a blocked agent's POST through", async () => {
		const { serve, fetchMock } = await setup();
		expect(
			await serve(originRequest({ agent: GPTBOT_UA, method: "POST" })),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets the renderer through", async () => {
		const { serve, fetchMock } = await setup();
		const request = originRequest({
			agent: GPTBOT_UA,
			headers: { "x-waniwani-render": header("X-WaniWani-Render", "1") },
		});
		expect(await serve(request)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage on CloudFront: failures return null", () => {
	it.each([
		["a 500", () => new Response(null, { status: 500 })],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
	])("when the rules fail with %s", async (_name, handler) => {
		const { serve } = await setup({ [RULES_URL]: handler });
		expect(await serve()).toBeNull();
		expect(await serve(originRequest({ agent: GPTBOT_UA }))).toBeNull();
	});

	it("when the stored page is a 404", async () => {
		const { serve } = await setup({
			[PRICING_URL]: () => new Response("missing", { status: 404 }),
		});
		expect(await serve()).toBeNull();
	});

	it("when the stored page is not text", async () => {
		const { serve } = await setup({
			[PRICING_URL]: page('{"a":1}', "application/json"),
		});
		expect(await serve()).toBeNull();
	});

	it("when the page headers miss their deadline", async () => {
		const { serve } = await setup({ [PRICING_URL]: hang });
		const started = Date.now();
		expect(await serve()).toBeNull();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("when the page body misses its deadline", async () => {
		const { serve } = await setup({
			[PRICING_URL]: () =>
				new Response(bytesStream([new TextEncoder().encode("# Pri")], false), {
					headers: { "content-type": "text/markdown" },
				}),
		});
		const started = Date.now();
		expect(await serve()).toBeNull();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("when the page is one byte over the cap", async () => {
		const { serve } = await setup({ [PRICING_URL]: page("x".repeat(17)) });
		expect(await serve()).toBeNull();
	});

	it("when the request has no headers at all", async () => {
		const { relay } = await setup();
		const request = originRequest();
		Reflect.deleteProperty(request, "headers");
		await expect(
			relay.serveAgentPage(request, {
				key: KEY,
				apiUrl: API_URL,
				hostname: HOST,
			}),
		).resolves.toBeNull();
	});

	it("when reading the headers throws", async () => {
		const { relay } = await setup();
		const request = originRequest();
		Object.defineProperty(request, "headers", {
			get() {
				throw new Error("boom");
			},
		});
		await expect(
			relay.serveAgentPage(request, {
				key: KEY,
				apiUrl: API_URL,
				hostname: HOST,
			}),
		).resolves.toBeNull();
	});
});

describe("markAgentRequest", () => {
	async function mark(request: CloudFrontRequest) {
		const relay = await freshRelay();
		const { fetchMock } = stubFetch({});
		const marked = relay.markAgentRequest(request, { rules: "bundled" });
		return { marked, fetchMock, relay };
	}

	it("marks an agent with its user agent", async () => {
		const request = viewerRequest(CHATGPT_USER_UA);
		const { marked } = await mark(request);
		expect(marked).toBe(true);
		expect(request.headers["x-waniwani-agent"]).toEqual([
			{ key: expect.any(String), value: CHATGPT_USER_UA },
		]);
		expect(request.headers["x-waniwani-agent"]?.[0]?.key?.toLowerCase()).toBe(
			"x-waniwani-agent",
		);
	});

	it("leaves a person unmarked", async () => {
		const request = viewerRequest(CHROME_UA);
		const { marked } = await mark(request);
		expect(marked).toBe(false);
		expect("x-waniwani-agent" in request.headers).toBe(false);
	});

	it("removes a header a person sent to pass as an agent", async () => {
		const request = viewerRequest(CHROME_UA, {
			"x-waniwani-agent": header("X-WaniWani-Agent", GPTBOT_UA),
		});
		const { marked } = await mark(request);
		expect(marked).toBe(false);
		expect("x-waniwani-agent" in request.headers).toBe(false);
	});

	it("replaces a header an agent sent with its real user agent", async () => {
		const request = viewerRequest(GPTBOT_UA, {
			"x-waniwani-agent": [
				{ key: "X-WaniWani-Agent", value: CHATGPT_USER_UA },
				{ key: "X-WaniWani-Agent", value: "Claude-User/1.0" },
			],
		});
		const { marked } = await mark(request);
		expect(marked).toBe(true);
		expect(request.headers["x-waniwani-agent"]).toEqual([
			{ key: expect.any(String), value: GPTBOT_UA },
		]);
	});

	it("keeps the other headers of the request", async () => {
		const request = viewerRequest(CHATGPT_USER_UA, {
			cookie: header("Cookie", "a=1"),
		});
		await mark(request);
		expect(request.headers.host).toEqual(header("Host", HOST));
		expect(request.headers["user-agent"]).toEqual(
			header("User-Agent", CHATGPT_USER_UA),
		);
		expect(request.headers.cookie).toEqual(header("Cookie", "a=1"));
	});

	it("returns false without throwing on a request with no headers", async () => {
		const request = viewerRequest(CHATGPT_USER_UA);
		Reflect.deleteProperty(request, "headers");
		const { marked } = await mark(request);
		expect(marked).toBe(false);
	});

	it("returns false without throwing when the headers cannot be read", async () => {
		const request = viewerRequest(CHATGPT_USER_UA);
		Object.defineProperty(request, "headers", {
			get() {
				throw new Error("boom");
			},
		});
		const { marked } = await mark(request);
		expect(marked).toBe(false);
	});

	it("does not throw when the remote rules refresh fails", async () => {
		const relay = await freshRelay();
		stubFetch({});
		const request = viewerRequest(CHATGPT_USER_UA);
		expect(relay.markAgentRequest(request, { apiUrl: API_URL })).toBe(true);
	});
});

describe("markAgentRequest then serveAgentPage", () => {
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

	async function roundTrip(viewer: CloudFrontRequest) {
		const relay = await freshRelay();
		const { calls } = stubFetch({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: page(),
		});
		relay.markAgentRequest(viewer, { rules: "bundled" });
		const result = await relay.serveAgentPage(toOrigin(viewer), {
			key: KEY,
			apiUrl: API_URL,
			hostname: HOST,
		});
		return { result, calls };
	}

	it("serves the page to an agent that acts for a user", async () => {
		const { result } = await roundTrip(viewerRequest(CHATGPT_USER_UA));
		expect(result?.status).toBe("200");
		expect(result?.body).toBe("# Pricing");
	});

	it("blocks a blocked agent", async () => {
		const { result } = await roundTrip(viewerRequest(GPTBOT_UA));
		expect(result?.status).toBe("403");
	});

	it("gives a person who spoofs the header the origin", async () => {
		const { result, calls } = await roundTrip(
			viewerRequest(CHROME_UA, {
				"x-waniwani-agent": header("X-WaniWani-Agent", CHATGPT_USER_UA),
			}),
		);
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("gives a person who spoofs a blocked agent the origin", async () => {
		const { result } = await roundTrip(
			viewerRequest(CHROME_UA, {
				"x-waniwani-agent": header("X-WaniWani-Agent", GPTBOT_UA),
			}),
		);
		expect(result).toBeNull();
	});
});
