import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServeAgentPageOptions } from "../src/index";
import { RELAY_VERSION } from "../src/version";
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
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const T0 = new Date("2026-11-03T00:00:00.000Z").getTime();

function siteRules(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens: ["chatgpt-user", "claude-user"],
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 16,
		sites: [
			{
				hostname: HOST,
				agentPages: { enabled: true, paths: ["/pricing", "/products/*"] },
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
	(body = "# Pricing", contentType = "text/markdown; charset=utf-8"): Handler =>
	() =>
		new Response(body, { headers: { "content-type": contentType } });

function streamOf(chunks: string[], end = true): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			if (end) {
				controller.close();
			}
		},
	});
}

function agentPageRequest(
	path = "/pricing",
	init: { method?: string; headers?: Record<string, string> } = {},
) {
	return new Request(`https://${HOST}${path}`, {
		method: init.method ?? "GET",
		headers: {
			"user-agent": "Mozilla/5.0 (compatible; ChatGPT-User/1.0)",
			...init.headers,
		},
	});
}

async function setup(
	routes: Record<string, Handler> = {
		[RULES_URL]: rulesAnswer(),
		[PRICING_URL]: page(),
	},
) {
	const relay = await freshRelay();
	const stub = stubFetch(routes);
	const serve = (
		request: Request = agentPageRequest(),
		options: ServeAgentPageOptions = {},
	) => relay.serveAgentPage(request, { key: KEY, apiUrl: API_URL, ...options });
	const urls = () => stub.calls.map((call) => call.url);
	return { ...stub, relay, serve, urls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
});

describe("serveAgentPage: a hit", () => {
	it("serves the stored page with the agent page headers", async () => {
		const { serve } = await setup();
		const response = await serve();
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("# Pricing");
		const headers: Record<string, string> = {};
		response?.headers.forEach((value, name) => {
			headers[name] = value;
		});
		expect(headers).toEqual({
			"content-type": "text/markdown; charset=utf-8",
			"x-waniwani-agent-page": "hit",
			"cache-control": "private, no-store",
			vary: "user-agent, accept",
		});
	});

	it("asks for markdown first and names the relay version", async () => {
		const { serve, calls } = await setup();
		await serve();
		const headers = new Headers(
			calls.find((call) => call.url === PRICING_URL)?.init?.headers,
		);
		expect(headers.get("accept")).toBe("text/markdown, text/html;q=0.9");
		expect(headers.get("x-waniwani-relay")).toBe(RELAY_VERSION);
	});

	it("drops the query string and the trailing slash from the page URL", async () => {
		const { serve, urls } = await setup();
		const response = await serve(agentPageRequest("/pricing/?plan=team#top"));
		expect(response?.status).toBe(200);
		expect(urls()).toContain(PRICING_URL);
	});

	it("answers HEAD with the same headers and no body", async () => {
		const { serve } = await setup();
		const response = await serve(
			agentPageRequest("/pricing", { method: "HEAD" }),
		);
		expect(response?.status).toBe(200);
		expect(response?.body).toBeNull();
		expect(response?.headers.get("content-type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response?.headers.get("x-waniwani-agent-page")).toBe("hit");
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(response?.headers.get("vary")).toBe("user-agent, accept");
	});

	it("serves a body of exactly the cap", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: page("x".repeat(16)),
		});
		expect(await (await serve())?.text()).toBe("x".repeat(16));
	});

	it("reads the key from the environment", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", KEY);
		const { relay } = await setup();
		const response = await relay.serveAgentPage(agentPageRequest(), {
			apiUrl: API_URL,
		});
		expect(response?.status).toBe(200);
	});
});

describe("serveAgentPage: falls through before any fetch", () => {
	it("returns null without a key", async () => {
		const { relay, fetchMock } = await setup();
		expect(
			await relay.serveAgentPage(agentPageRequest(), { apiUrl: API_URL }),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns null for a malformed key", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { serve, fetchMock } = await setup();
		expect(await serve(agentPageRequest(), { key: "nope" })).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("returns null for an unknown region", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { relay, fetchMock } = await setup();
		expect(
			await relay.serveAgentPage(agentPageRequest(), {
				key: KEY,
				// @ts-expect-error an unknown region from untyped config
				region: "mars",
			}),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS"])(
		"returns null for %s",
		async (method) => {
			const { serve, fetchMock } = await setup();
			expect(await serve(agentPageRequest("/pricing", { method }))).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("returns null for the renderer's own request", async () => {
		const { serve, fetchMock } = await setup();
		expect(
			await serve(
				agentPageRequest("/pricing", { headers: { "x-waniwani-render": "1" } }),
			),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage: the rules file", () => {
	it("calls the rules route of the org token", async () => {
		const { serve, urls } = await setup();
		await serve();
		expect(urls()[0]).toBe(RULES_URL);
	});

	it.each([
		["a 500", () => new Response("nope", { status: 500 })],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
		["invalid JSON", () => new Response("{", { status: 200 })],
		["no envelope", () => Response.json(siteRules())],
		["version 2", rulesAnswer(siteRules({ version: 2 }))],
		["no pagesUrl", rulesAnswer(siteRules({ pagesUrl: undefined }))],
		["string tokens", rulesAnswer(siteRules({ userAgentTokens: "claude" }))],
		["no deadlines", rulesAnswer(siteRules({ deadlines: null }))],
		[
			"a zero deadline",
			rulesAnswer(siteRules({ deadlines: { headersMs: 0, bodyMs: 50 } })),
		],
		["a missing cap", rulesAnswer(siteRules({ maxBodyBytes: "16" }))],
		["sites as an object", rulesAnswer(siteRules({ sites: {} }))],
		[
			"a site without paths",
			rulesAnswer(
				siteRules({
					sites: [{ hostname: HOST, agentPages: { enabled: true } }],
				}),
			),
		],
		[
			"enabled as a string",
			rulesAnswer(
				siteRules({
					sites: [
						{ hostname: HOST, agentPages: { enabled: "yes", paths: ["*"] } },
					],
				}),
			),
		],
	])("returns null on %s and never fetches a page", async (_name, handler) => {
		const { serve, urls } = await setup({
			[RULES_URL]: handler,
			[PRICING_URL]: page(),
		});
		expect(await serve()).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null for a host the rules do not list", async () => {
		const { serve, urls } = await setup();
		const request = new Request("https://docs.example.com/pricing", {
			headers: { "user-agent": "ChatGPT-User/1.0" },
		});
		expect(await serve(request)).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null when agent pages are off for the site", async () => {
		const { serve, urls } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules({
					sites: [
						{ hostname: HOST, agentPages: { enabled: false, paths: ["*"] } },
					],
				}),
			),
			[PRICING_URL]: page(),
		});
		expect(await serve()).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("matches the host whatever its case in the rules file", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules({
					sites: [
						{
							hostname: "WWW.Example.COM",
							agentPages: { enabled: true, paths: ["/pricing"] },
						},
					],
				}),
			),
			[PRICING_URL]: page(),
		});
		expect((await serve())?.status).toBe(200);
	});

	it("accepts a pagesUrl with a trailing slash", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(siteRules({ pagesUrl: `${PAGES_URL}/` })),
			[PRICING_URL]: page(),
		});
		expect((await serve())?.status).toBe(200);
	});

	it("gives up on the first load after 300 ms", async () => {
		const { serve } = await setup({ [RULES_URL]: hang, [PRICING_URL]: page() });
		const started = Date.now();
		expect(await serve()).toBeNull();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(1500);
	});
});

describe("serveAgentPage: paths", () => {
	async function served(path: string, paths: string[]) {
		const { serve, urls } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules({
					sites: [{ hostname: HOST, agentPages: { enabled: true, paths } }],
				}),
			),
		});
		await serve(agentPageRequest(path));
		return urls().some((url) => url.startsWith(PAGES_URL));
	}

	it.each([
		["/products", true],
		["/products/", true],
		["/products/shoes", true],
		["/products/shoes/red", true],
		["/productsx", false],
		["/product", false],
		["/", false],
		["/about/products/shoes", false],
	])("folder /products/* and %s gives %s", async (path, expected) => {
		expect(await served(path, ["/products/*"])).toBe(expected);
	});

	it.each([
		["/pricing", true],
		["/pricing/", true],
		["/pricing/team", false],
		["/Pricing", false],
		["/pricin", false],
	])("exact /pricing and %s gives %s", async (path, expected) => {
		expect(await served(path, ["/pricing"])).toBe(expected);
	});

	it.each(["*", "/*"])("%s matches every path", async (pattern) => {
		expect(await served("/", [pattern])).toBe(true);
		expect(await served("/a/b/c", [pattern])).toBe(true);
	});

	it("matches the root only when listed", async () => {
		expect(await served("/", ["/"])).toBe(true);
		expect(await served("/pricing", ["/"])).toBe(false);
	});

	it("fetches the root page at the host with a slash", async () => {
		const rootUrl = `${PAGES_URL}/${HOST}/`;
		const { serve, urls } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules({
					sites: [
						{ hostname: HOST, agentPages: { enabled: true, paths: ["/"] } },
					],
				}),
			),
			[rootUrl]: page(),
		});
		expect((await serve(agentPageRequest("/")))?.status).toBe(200);
		expect(urls()).toContain(rootUrl);
	});

	it("returns null when no entry matches", async () => {
		expect(await served("/blog", ["/pricing", "/products/*"])).toBe(false);
	});
});

describe("serveAgentPage: user agents", () => {
	it.each([
		["a browser", "Mozilla/5.0 (Macintosh) Safari/605.1.15"],
		["a training crawler", "Mozilla/5.0 (compatible; GPTBot/1.2)"],
		["no user agent", ""],
	])("returns null for %s", async (_name, userAgent) => {
		const { serve, urls } = await setup();
		const request = new Request(`https://${HOST}/pricing`, {
			headers: userAgent ? { "user-agent": userAgent } : {},
		});
		expect(await serve(request)).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("matches a token whatever the case of the user agent", async () => {
		const { serve } = await setup();
		const request = new Request(`https://${HOST}/pricing`, {
			headers: { "user-agent": "CLAUDE-USER/1.0" },
		});
		expect((await serve(request))?.status).toBe(200);
	});

	it("ignores an empty token", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(siteRules({ userAgentTokens: [""] })),
			[PRICING_URL]: page(),
		});
		expect(await serve()).toBeNull();
	});
});

describe("serveAgentPage: the stored page", () => {
	it.each([
		["a 404", () => new Response("missing", { status: 404 })],
		[
			"a 201",
			() =>
				new Response("x", {
					status: 201,
					headers: { "content-type": "text/markdown" },
				}),
		],
		["JSON", page('{"a":1}', "application/json")],
		["no content type", () => new Response(new Uint8Array([1, 2]))],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
	])("returns null for %s", async (_name, handler) => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: handler,
		});
		expect(await serve()).toBeNull();
	});

	it("accepts text/html", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: page("<h1>x</h1>", "text/html"),
		});
		const response = await serve();
		expect(response?.headers.get("content-type")).toBe("text/html");
	});

	it("aborts and returns null when the headers miss their deadline", async () => {
		let aborted = false;
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: (url, init) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return hang(url, init);
			},
		});
		const started = Date.now();
		expect(await serve()).toBeNull();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(aborted).toBe(true);
	});

	it("returns null when the fetch ignores the abort signal", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: () => new Promise<Response>(() => {}),
		});
		expect(await serve()).toBeNull();
	});

	it("returns null when the body misses its deadline", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: () =>
				new Response(streamOf(["# Pri"], false), {
					headers: { "content-type": "text/markdown" },
				}),
		});
		const started = Date.now();
		expect(await serve()).toBeNull();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("returns null past the cap even when Content-Length claims less", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: () =>
				new Response(streamOf(["0123456789", "0123456"]), {
					headers: { "content-type": "text/markdown", "content-length": "5" },
				}),
		});
		expect(await serve()).toBeNull();
	});

	it("joins a body that arrives in chunks", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: () =>
				new Response(streamOf(["# Pri", "cing"]), {
					headers: { "content-type": "text/markdown" },
				}),
		});
		expect(await (await serve())?.text()).toBe("# Pricing");
	});

	it("returns null on HEAD when the stored page is missing", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: () => new Response(null, { status: 404 }),
		});
		expect(
			await serve(agentPageRequest("/pricing", { method: "HEAD" })),
		).toBeNull();
	});
});

describe("serveAgentPage: the rules cache", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
	});

	const rulesCalls = (urls: string[]) =>
		urls.filter((url) => url === RULES_URL).length;

	it("loads the rules once while they are fresh", async () => {
		const { serve, urls } = await setup();
		await serve();
		vi.setSystemTime(T0 + 59_999);
		await serve();
		await settle();
		expect(rulesCalls(urls())).toBe(1);
	});

	it("serves stale rules at once and refreshes them in the background", async () => {
		let answer = siteRules();
		let release: () => void = () => {};
		const { serve, urls } = await setup({
			[RULES_URL]: async () => {
				const data = answer;
				if (rulesCalls(urls()) > 1) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				return Response.json({ success: true, message: "success", data });
			},
			[PRICING_URL]: page(),
		});
		expect((await serve())?.status).toBe(200);

		answer = siteRules({ sites: [] });
		vi.setSystemTime(T0 + 60_000);
		expect((await serve())?.status).toBe(200);
		expect((await serve())?.status).toBe(200);
		expect((await serve())?.status).toBe(200);
		expect(rulesCalls(urls())).toBe(2);

		release();
		await settle();
		expect(await serve()).toBeNull();
		expect(rulesCalls(urls())).toBe(2);
	});

	it("keeps stale rules when the refresh fails and retries after 5 s", async () => {
		let fail = false;
		const { serve, urls } = await setup({
			[RULES_URL]: () =>
				fail
					? new Response(null, { status: 503 })
					: Response.json({ success: true, data: siteRules() }),
			[PRICING_URL]: page(),
		});
		await serve();
		fail = true;
		vi.setSystemTime(T0 + 60_000);
		expect((await serve())?.status).toBe(200);
		await settle();
		expect(rulesCalls(urls())).toBe(2);

		vi.setSystemTime(T0 + 64_999);
		expect((await serve())?.status).toBe(200);
		await settle();
		expect(rulesCalls(urls())).toBe(2);

		vi.setSystemTime(T0 + 65_000);
		expect((await serve())?.status).toBe(200);
		await settle();
		expect(rulesCalls(urls())).toBe(3);
	});

	it("shares one first load between concurrent requests", async () => {
		let release: () => void = () => {};
		const { serve, urls } = await setup({
			[RULES_URL]: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return Response.json({ success: true, data: siteRules() });
			},
			[PRICING_URL]: page(),
		});
		const pending = [serve(), serve(), serve()];
		await settle();
		release();
		const responses = await Promise.all(pending);
		expect(responses.map((response) => response?.status)).toEqual([
			200, 200, 200,
		]);
		expect(rulesCalls(urls())).toBe(1);
	});

	it("caches nothing on a failed first load and retries no sooner than 5 s", async () => {
		let fail = true;
		const { serve, urls } = await setup({
			[RULES_URL]: () =>
				fail
					? new Response(null, { status: 500 })
					: Response.json({ success: true, data: siteRules() }),
			[PRICING_URL]: page(),
		});
		expect(await serve()).toBeNull();
		fail = false;
		vi.setSystemTime(T0 + 4_999);
		expect(await serve()).toBeNull();
		expect(rulesCalls(urls())).toBe(1);

		vi.setSystemTime(T0 + 5_000);
		expect((await serve())?.status).toBe(200);
		expect(rulesCalls(urls())).toBe(2);
	});

	it("keeps a separate cache per API URL and token", async () => {
		const otherKey = "wwt_other.b3JnLWtleS1zZWNyZXQ";
		const otherRules = `${API_URL}/api/v2/agent-traffic/serve/other/rules`;
		const { serve, urls } = await setup({
			[RULES_URL]: rulesAnswer(),
			[otherRules]: rulesAnswer(siteRules({ sites: [] })),
			[PRICING_URL]: page(),
		});
		expect((await serve())?.status).toBe(200);
		expect(await serve(agentPageRequest(), { key: otherKey })).toBeNull();
		expect(urls().filter((url) => url === otherRules)).toHaveLength(1);
	});

	it("hands the background refresh to the Vercel waitUntil", async () => {
		const waited: Promise<unknown>[] = [];
		Reflect.set(globalThis, REQUEST_CONTEXT, {
			get: () => ({
				waitUntil: (promise: Promise<unknown>) => waited.push(promise),
			}),
		});
		const { serve } = await setup();
		await serve();
		expect(waited).toHaveLength(0);
		vi.setSystemTime(T0 + 60_000);
		await serve();
		expect(waited).toHaveLength(1);
		await Promise.all(waited);
	});
});

describe("serveAgentPage: never throws", () => {
	it("returns null when reading the request throws", async () => {
		const { relay } = await setup();
		const request = agentPageRequest();
		Object.defineProperty(request, "headers", {
			get() {
				throw new Error("boom");
			},
		});
		await expect(
			relay.serveAgentPage(request, { key: KEY, apiUrl: API_URL }),
		).resolves.toBeNull();
	});
});
