import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersMarkdown } from "../src/agent-page";
import type { RelayOptions, ServeAgentPageOptions } from "../src/index";
import {
	API_URL,
	collector,
	freshRelay,
	type Handler,
	INGEST_TOKEN,
	INGEST_URL,
	ingestBodies,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/rules`;
const BOT_LIST_URL = `${API_URL}/api/v2/agent-traffic/rules`;
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;

const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const FIREFOX_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";
const CURL_UA = "curl/8.7.1";
const CLAUDEBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

const CHROME_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const SAFARI_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const FIREFOX_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8";

type Site = {
	hostname: string;
	blockedUserAgentTokens: string[];
	agentPages: { enabled: boolean; paths: string[] };
};

const site = (overrides: Partial<Site> = {}): Site => ({
	hostname: HOST,
	blockedUserAgentTokens: [],
	agentPages: { enabled: true, paths: ["/pricing"] },
	...overrides,
});

function siteRules(
	sites: Site[] = [site()],
	userAgentTokens = ["chatgpt-user", "claude-user"],
) {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens,
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 64,
		sites,
	};
}

const rulesAnswer =
	(data: unknown = siteRules()): Handler =>
	() =>
		Response.json({ success: true, message: "success", data });

const markdownPage: Handler = () =>
	new Response("# Pricing", {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});

function clientRequest(
	userAgent: string | null,
	init: {
		accept?: string;
		path?: string;
		method?: string;
		headers?: Record<string, string>;
	} = {},
) {
	return new Request(`https://${HOST}${init.path ?? "/pricing"}`, {
		method: init.method ?? "GET",
		headers: {
			...(userAgent === null ? {} : { "user-agent": userAgent }),
			...(init.accept === undefined ? {} : { accept: init.accept }),
			...init.headers,
		},
	});
}

async function setup(routes: Record<string, Handler> = {}) {
	const relay = await freshRelay();
	const stub = stubFetch({
		[RULES_URL]: rulesAnswer(),
		[PRICING_URL]: markdownPage,
		...routes,
	});
	const serve = (request: Request, options: ServeAgentPageOptions = {}) =>
		relay.serveAgentPage(request, { key: KEY, apiUrl: API_URL, ...options });
	const urls = () => stub.calls.map((call) => call.url);
	const acceptSentUpstream = () =>
		stub.calls
			.filter((call) => call.url.startsWith(PAGES_URL))
			.map((call) => new Headers(call.init?.headers).get("accept"));
	return { ...stub, relay, serve, urls, acceptSentUpstream };
}

function headersOf(response: Response | null): Record<string, string> {
	const out: Record<string, string> = {};
	response?.headers.forEach((value, name) => {
		out[name] = value;
	});
	return out;
}

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("prefersMarkdown", () => {
	it.each([
		"text/markdown",
		"text/markdown, text/html;q=0.9",
		"text/markdown, text/html",
		"text/html;q=0.5, text/markdown;q=0.5",
		"text/html, text/markdown",
		"TEXT/MARKDOWN",
		"Text/Markdown;Q=0.9, TEXT/HTML;Q=0.8",
		"  text/markdown  ,  text/html ; q=0.1 ",
		"text/markdown\t;\tq=0.7,\ttext/html;q=0.6",
		"text/markdown;q=0.001",
		"application/json, text/markdown;q=0.1",
		"text/markdown, */*;q=0.8",
		"text/markdown;q=0.8, text/*;q=0.8",
		"text/markdown;q=0.9, text/*;q=1, text/html;q=0.5",
		"text/markdown;q=0.5, */*, text/html;q=0.4",
		"text/markdown;q=0.5, text/html;q=0",
		"text/markdown;charset=utf-8;q=0.9;level=1, text/html;q=0.8",
		"text/html;q=0.8, text/markdown;q=0.9;format=gfm",
		",text/markdown,",
		"text/markdown;q=1.0, text/html;q=1",
	])("prefers Markdown for %j", (accept) => {
		expect(prefersMarkdown(accept)).toBe(true);
	});

	it.each([
		["empty", ""],
		["whitespace only", "   "],
		["a lone comma", ","],
		["HTML only", "text/html"],
		["curl's default", "*/*"],
		["any text", "text/*"],
		["Markdown ranked below HTML", "text/html, text/markdown;q=0.5"],
		["Markdown below text/*", "text/markdown;q=0.5, text/*;q=0.6"],
		["Markdown below */*", "text/markdown;q=0.5, */*"],
		[
			"text/html more specific than text/*",
			"text/markdown;q=0.9, text/*;q=0.5, text/html;q=1",
		],
		["text/* more specific than */*", "text/markdown;q=0.7, */*;q=0.1, text/*"],
		["Markdown refused", "text/markdown;q=0"],
		["Markdown refused as 0.0", "text/markdown;q=0.0"],
		["Markdown and HTML both refused", "text/markdown;q=0, text/html;q=0"],
		["a negative q", "text/markdown;q=-1"],
		["a q that is not a number", "text/markdown;q=abc"],
		["an empty q", "text/markdown;q="],
		["a lookalike type", "text/markdownx"],
		["text/x-markdown", "text/x-markdown"],
		["application/markdown", "application/markdown"],
		["Markdown only as a parameter", "text/html;format=text/markdown"],
		["Chrome", CHROME_ACCEPT],
		["Safari", SAFARI_ACCEPT],
		["Firefox", FIREFOX_ACCEPT],
		[
			"a browser image request",
			"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
		],
	])("does not prefer Markdown for %s", (_name, accept) => {
		expect(prefersMarkdown(accept)).toBe(false);
	});

	it("reads the highest q of a repeated HTML range, as it does for a repeated Markdown range", () => {
		expect(prefersMarkdown("text/markdown;q=0, text/markdown;q=0.6")).toBe(
			true,
		);
		expect(
			prefersMarkdown("text/html;q=0.1, text/html;q=0.9, text/markdown;q=0.5"),
		).toBe(false);
	});

	it("does not read a q written with spaces around the equals sign as q=1", () => {
		expect(prefersMarkdown("text/html, text/markdown;q = 0.1")).toBe(false);
	});
});

describe("serveAgentPage: a client that is not an AI agent and prefers Markdown", () => {
	it("is not an AI agent to the bundled bot list", async () => {
		const { relay } = await setup();
		for (const userAgent of [CHROME_UA, SAFARI_UA, FIREFOX_UA, CURL_UA]) {
			expect(
				relay.isAgent(clientRequest(userAgent), { rules: "bundled" }),
			).toBe(false);
		}
	});

	it("gets the stored Markdown page with the agent page headers", async () => {
		const { serve, acceptSentUpstream } = await setup();
		const response = await serve(
			clientRequest(CHROME_UA, { accept: "text/markdown" }),
		);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("# Pricing");
		expect(headersOf(response)).toEqual({
			"content-type": "text/markdown; charset=utf-8",
			"x-waniwani-agent-page": "hit",
			"cache-control": "private, no-store",
			vary: "user-agent, accept",
		});
		expect(acceptSentUpstream()).toEqual(["text/markdown"]);
	});

	it.each([
		["curl", CURL_UA, "text/markdown, */*;q=0.1"],
		["a script with no user agent", null, "text/markdown"],
		[
			"a browser that ranks Markdown first",
			FIREFOX_UA,
			"text/markdown, text/html;q=0.9",
		],
		[
			"a client that ties Markdown with HTML",
			SAFARI_UA,
			"text/html, text/markdown",
		],
	])("serves %s the Markdown page", async (_name, userAgent, accept) => {
		const { serve, acceptSentUpstream } = await setup();
		const response = await serve(clientRequest(userAgent, { accept }));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("vary")).toBe("user-agent, accept");
		expect(acceptSentUpstream()).toEqual(["text/markdown"]);
	});

	it("never fetches the HTML agent page, even when the stored page is HTML", async () => {
		const { serve, acceptSentUpstream } = await setup({
			[PRICING_URL]: () =>
				new Response("<h1>Pricing</h1>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		});
		await serve(clientRequest(CHROME_UA, { accept: "text/markdown" }));
		expect(acceptSentUpstream()).toEqual(["text/markdown"]);
	});

	it("answers HEAD with the page headers and no body", async () => {
		const { serve } = await setup();
		const response = await serve(
			clientRequest(CHROME_UA, { accept: "text/markdown", method: "HEAD" }),
		);
		expect(response?.status).toBe(200);
		expect(response?.body).toBeNull();
		expect(headersOf(response)).toEqual({
			"content-type": "text/markdown; charset=utf-8",
			"x-waniwani-agent-page": "hit",
			"cache-control": "private, no-store",
			vary: "user-agent, accept",
		});
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS", "PATCH"])(
		"returns null for %s without a network call",
		async (method) => {
			const { serve, fetchMock } = await setup();
			expect(
				await serve(
					clientRequest(CHROME_UA, { accept: "text/markdown", method }),
				),
			).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("returns null without a key and without a network call", async () => {
		const { relay, fetchMock } = await setup();
		expect(
			await relay.serveAgentPage(
				clientRequest(CHROME_UA, { accept: "text/markdown" }),
				{ apiUrl: API_URL },
			),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns null for the renderer's own request without fetching the page", async () => {
		const { serve, urls } = await setup();
		const request = clientRequest(CHROME_UA, {
			accept: "text/markdown",
			headers: { "x-waniwani-render": "1" },
		});
		expect(await serve(request)).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null when agent pages are off for the site", async () => {
		const { serve, urls } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ agentPages: { enabled: false, paths: ["*"] } })]),
			),
		});
		expect(
			await serve(clientRequest(CHROME_UA, { accept: "text/markdown" })),
		).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null on a path that is not an agent page", async () => {
		const { serve, urls } = await setup();
		expect(
			await serve(
				clientRequest(CHROME_UA, { accept: "text/markdown", path: "/blog" }),
			),
		).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null for a host the rules do not list", async () => {
		const { serve, urls } = await setup();
		const request = new Request("https://docs.example.com/pricing", {
			headers: { "user-agent": CHROME_UA, accept: "text/markdown" },
		});
		expect(await serve(request)).toBeNull();
		expect(urls()).toEqual([RULES_URL]);
	});

	it("returns null when the stored page is missing", async () => {
		const { serve } = await setup({
			[PRICING_URL]: () => new Response("missing", { status: 404 }),
		});
		expect(
			await serve(clientRequest(CHROME_UA, { accept: "text/markdown" })),
		).toBeNull();
	});
});

describe("serveAgentPage: a client that is not an AI agent and does not prefer Markdown", () => {
	it.each([
		["Chrome", CHROME_UA, CHROME_ACCEPT],
		["Safari", SAFARI_UA, SAFARI_ACCEPT],
		["Firefox", FIREFOX_UA, FIREFOX_ACCEPT],
		["curl", CURL_UA, "*/*"],
		["a browser with no Accept header", CHROME_UA, undefined],
		["a browser with an empty Accept header", CHROME_UA, ""],
		["no user agent and no Accept header", null, undefined],
		["Markdown ranked below HTML", CHROME_UA, "text/html, text/markdown;q=0.5"],
		["Markdown refused", CURL_UA, "text/markdown;q=0"],
		["Markdown below */*", CURL_UA, "text/markdown;q=0.5, */*"],
	])(
		"returns null for %s with no network call",
		async (_name, userAgent, accept) => {
			const { serve, fetchMock } = await setup();
			expect(await serve(clientRequest(userAgent, { accept }))).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("returns null for a HEAD from a browser with no network call", async () => {
		const { serve, fetchMock } = await setup();
		expect(
			await serve(
				clientRequest(CHROME_UA, { accept: CHROME_ACCEPT, method: "HEAD" }),
			),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage: blocked tokens and a client that prefers Markdown", () => {
	const blocksCurl = () => ({
		[RULES_URL]: rulesAnswer(
			siteRules([site({ blockedUserAgentTokens: ["curl"] })]),
		),
	});

	it("answers 403 to a blocked user agent that prefers Markdown", async () => {
		const { serve, acceptSentUpstream } = await setup(blocksCurl());
		const response = await serve(
			clientRequest(CURL_UA, { accept: "text/markdown" }),
		);
		expect(response?.status).toBe(403);
		expect(await response?.text()).toBe("Forbidden");
		expect(headersOf(response)).toEqual({
			"content-type": "text/plain; charset=utf-8",
			"x-waniwani-blocked": "1",
			"cache-control": "private, no-store",
			vary: "user-agent",
		});
		expect(acceptSentUpstream()).toEqual([]);
	});

	it("answers HEAD from a blocked user agent that prefers Markdown with no body", async () => {
		const { serve } = await setup(blocksCurl());
		const response = await serve(
			clientRequest(CURL_UA, { accept: "text/markdown", method: "HEAD" }),
		);
		expect(response?.status).toBe(403);
		expect(response?.body).toBeNull();
	});

	it("blocks before the render header check and with agent pages off", async () => {
		const { serve } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([
					site({
						blockedUserAgentTokens: ["curl"],
						agentPages: { enabled: false, paths: [] },
					}),
				]),
			),
		});
		const response = await serve(
			clientRequest(CURL_UA, {
				accept: "text/markdown",
				headers: { "x-waniwani-render": "1" },
			}),
		);
		expect(response?.status).toBe(403);
	});

	it("lets the same blocked user agent through with no network call when it asks for anything", async () => {
		const { serve, fetchMock } = await setup(blocksCurl());
		expect(await serve(clientRequest(CURL_UA, { accept: "*/*" }))).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage: AI agents keep their behavior", () => {
	it.each([
		["text/html, text/markdown;q=0.5", "text/markdown"],
		["text/markdown;q=0.001, text/html", "text/markdown"],
		["text/markdown", "text/markdown"],
		["text/html", "text/html"],
		["*/*", "text/html"],
		["text/markdown;q=0", "text/html"],
		["text/markdown;q=abc", "text/html"],
		[undefined, "text/html"],
	])(
		"a user-acting agent with Accept %j gets the page fetched as %j",
		async (accept, upstream) => {
			const { serve, acceptSentUpstream } = await setup();
			const response = await serve(clientRequest(CHATGPT_USER_UA, { accept }));
			expect(response?.status).toBe(200);
			expect(acceptSentUpstream()).toEqual([upstream]);
		},
	);

	describe("a user agent that only the site rules list", () => {
		const acmeUa = "Mozilla/5.0 (compatible; Acme-User/1.0)";
		const acmeSetup = () =>
			setup({
				[RULES_URL]: rulesAnswer(
					siteRules([site()], ["chatgpt-user", "claude-user", "acme-user"]),
				),
			});

		it("is not an AI agent to the bundled bot list", async () => {
			const { relay } = await acmeSetup();
			expect(relay.isAgent(clientRequest(acmeUa), { rules: "bundled" })).toBe(
				false,
			);
		});

		it.each(["text/html", "*/*", undefined])(
			"returns null with no network call for Accept %j",
			async (accept) => {
				const { serve, fetchMock } = await acmeSetup();
				expect(await serve(clientRequest(acmeUa, { accept }))).toBeNull();
				expect(fetchMock).not.toHaveBeenCalled();
			},
		);

		it("gets the Markdown page when it prefers Markdown", async () => {
			const { serve, acceptSentUpstream } = await acmeSetup();
			const response = await serve(
				clientRequest(acmeUa, { accept: "text/markdown" }),
			);
			expect(response?.status).toBe(200);
			expect(acceptSentUpstream()).toEqual(["text/markdown"]);
		});
	});

	it.each([
		["text/html", null],
		["*/*", null],
		[undefined, null],
		["text/html, text/markdown;q=0.5", null],
		["text/markdown", "text/markdown"],
	])(
		"a training crawler with Accept %j gets the page fetched as %j",
		async (accept, upstream) => {
			const { serve, urls, acceptSentUpstream } = await setup();
			const response = await serve(clientRequest(CLAUDEBOT_UA, { accept }));
			expect(response?.status ?? null).toBe(upstream === null ? null : 200);
			expect(urls()[0]).toBe(RULES_URL);
			expect(acceptSentUpstream()).toEqual(upstream === null ? [] : [upstream]);
		},
	);
});

describe("the customer snippet records nothing for a person who asks for Markdown", () => {
	async function snippetSetup() {
		const relay = await freshRelay();
		const stub = stubFetch({
			[RULES_URL]: rulesAnswer(),
			[PRICING_URL]: markdownPage,
			[INGEST_URL]: () => new Response(null, { status: 202 }),
			[BOT_LIST_URL]: () => new Response(null, { status: 503 }),
		});
		const background = collector();
		const recordOptions: RelayOptions = {
			key: KEY,
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		};
		const pageOptions: ServeAgentPageOptions = { key: KEY, apiUrl: API_URL };
		async function proxy(request: Request) {
			if (relay.isAgent(request, recordOptions)) {
				relay.recordAgentVisit(request, recordOptions);
			}
			const agentPage = await relay.serveAgentPage(request, pageOptions);
			if (agentPage) {
				return agentPage;
			}
		}
		const posted = async () => {
			await background.flush();
			return {
				bodies: ingestBodies(stub.calls),
				ingestCalls: stub.calls.filter((call) => call.url.includes("/ingest/"))
					.length,
			};
		};
		return { proxy, posted };
	}

	it("serves the Markdown page to a browser and posts no event", async () => {
		const { proxy, posted } = await snippetSetup();
		const response = await proxy(
			clientRequest(CHROME_UA, { accept: "text/markdown" }),
		);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("# Pricing");
		expect(await posted()).toEqual({ bodies: [], ingestCalls: 0 });
	});

	it("posts no event for curl that prefers Markdown", async () => {
		const { proxy, posted } = await snippetSetup();
		const response = await proxy(
			clientRequest(CURL_UA, { accept: "text/markdown, */*;q=0.1" }),
		);
		expect(response?.status).toBe(200);
		expect(await posted()).toEqual({ bodies: [], ingestCalls: 0 });
	});

	it("passes a browser through and posts no event", async () => {
		const { proxy, posted } = await snippetSetup();
		expect(
			await proxy(clientRequest(CHROME_UA, { accept: CHROME_ACCEPT })),
		).toBeUndefined();
		expect(await posted()).toEqual({ bodies: [], ingestCalls: 0 });
	});

	it("posts one event for a user-acting agent that asks for Markdown", async () => {
		const { proxy, posted } = await snippetSetup();
		const response = await proxy(
			clientRequest(CHATGPT_USER_UA, { accept: "text/markdown" }),
		);
		expect(response?.status).toBe(200);
		const { bodies } = await posted();
		expect(bodies).toHaveLength(1);
		expect(bodies[0].requests).toHaveLength(1);
		expect(bodies[0].requests[0].path).toBe("/pricing");
		expect(bodies[0].requests[0].userAgent).toBe(CHATGPT_USER_UA);
	});
});
