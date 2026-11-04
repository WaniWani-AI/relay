import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServeAgentPageOptions } from "../src/index";
import {
	API_URL,
	freshRelay,
	type Handler,
	INGEST_TOKEN,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/rules`;
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const DOCS = "docs.example.com";
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;

const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Site = {
	hostname: string;
	blockedUserAgentTokens?: unknown;
	agentPages: { enabled: boolean; paths: string[] };
};

const site = (overrides: Partial<Site> = {}): Site => ({
	hostname: HOST,
	blockedUserAgentTokens: ["gptbot"],
	agentPages: { enabled: true, paths: ["/pricing"] },
	...overrides,
});

function siteRules(sites: Site[] = [site()]) {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens: ["chatgpt-user", "claude-user"],
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 16,
		sites,
	};
}

const rulesAnswer =
	(data: unknown = siteRules()): Handler =>
	() =>
		Response.json({ success: true, message: "success", data });

const page: Handler = () =>
	new Response("# Pricing", {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});

function request(
	userAgent: string | null,
	init: {
		url?: string;
		method?: string;
		headers?: Record<string, string>;
	} = {},
) {
	return new Request(init.url ?? `https://${HOST}/pricing`, {
		method: init.method ?? "GET",
		headers: {
			...(userAgent === null ? {} : { "user-agent": userAgent }),
			...init.headers,
		},
	});
}

async function setup(
	rules: unknown = siteRules(),
	routes: Record<string, Handler> = {},
) {
	const relay = await freshRelay();
	const stub = stubFetch({
		[RULES_URL]: rulesAnswer(rules),
		[PRICING_URL]: page,
		...routes,
	});
	const serve = (req: Request, options: ServeAgentPageOptions = {}) =>
		relay.serveAgentPage(req, { key: KEY, apiUrl: API_URL, ...options });
	const pageFetched = () =>
		stub.calls.some((call) => call.url.startsWith(PAGES_URL));
	return { ...stub, relay, serve, pageFetched };
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
});

describe("serveAgentPage blocking: the 403", () => {
	it("answers a blocked agent with Forbidden and the blocked headers, without fetching a page", async () => {
		const { serve, pageFetched } = await setup();
		const response = await serve(request(GPTBOT_UA));
		expect(response?.status).toBe(403);
		expect(await response?.text()).toBe("Forbidden");
		expect(headersOf(response)).toEqual({
			"content-type": "text/plain; charset=utf-8",
			"x-waniwani-blocked": "1",
			"cache-control": "private, no-store",
			vary: "user-agent",
		});
		expect(pageFetched()).toBe(false);
	});

	it("answers HEAD from a blocked agent with the 403 headers and no body", async () => {
		const { serve } = await setup();
		const response = await serve(request(GPTBOT_UA, { method: "HEAD" }));
		expect(response?.status).toBe(403);
		expect(response?.body).toBeNull();
		expect(response?.headers.get("x-waniwani-blocked")).toBe("1");
	});

	it("matches a lowercase HEAD method too", async () => {
		const { serve } = await setup();
		const response = await serve(request(GPTBOT_UA, { method: "head" }));
		expect(response?.status).toBe(403);
		expect(response?.body).toBeNull();
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS"])(
		"lets a blocked agent's %s through to the origin",
		async (method) => {
			const { serve, fetchMock } = await setup();
			expect(await serve(request(GPTBOT_UA, { method }))).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("lets the renderer through even with a blocked user agent", async () => {
		const { serve, fetchMock } = await setup();
		const response = await serve(
			request(GPTBOT_UA, { headers: { "x-waniwani-render": "1" } }),
		);
		expect(response).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks on a site with agent pages off", async () => {
		const { serve } = await setup(
			siteRules([site({ agentPages: { enabled: false, paths: [] } })]),
		);
		expect((await serve(request(GPTBOT_UA)))?.status).toBe(403);
	});

	it("blocks on a path that is not an agent page", async () => {
		const { serve } = await setup();
		const response = await serve(
			request(GPTBOT_UA, { url: `https://${HOST}/careers/apply` }),
		);
		expect(response?.status).toBe(403);
	});

	it("blocks an agent that acts for a user instead of serving it the page", async () => {
		const { serve, pageFetched } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["chatgpt-user"] })]),
		);
		expect((await serve(request(CHATGPT_USER_UA)))?.status).toBe(403);
		expect(pageFetched()).toBe(false);
	});

	it("needs a key to block", async () => {
		const { relay, fetchMock } = await setup();
		expect(
			await relay.serveAgentPage(request(GPTBOT_UA), { apiUrl: API_URL }),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("serveAgentPage blocking: who gets blocked", () => {
	it.each([
		["a browser", CHROME_UA],
		["an agent acting for a user", CHATGPT_USER_UA],
		["no user agent", null],
	])(
		"never blocks %s when only gptbot is blocked",
		async (_name, userAgent) => {
			const { serve } = await setup(
				siteRules([site({ agentPages: { enabled: false, paths: [] } })]),
			);
			expect(await serve(request(userAgent))).toBeNull();
		},
	);

	it("still serves the agent page to an unblocked agent on a site that blocks another", async () => {
		const { serve } = await setup();
		const response = await serve(request(CHATGPT_USER_UA));
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("# Pricing");
	});

	it("blocks whatever the case of the user agent", async () => {
		const { serve } = await setup();
		expect((await serve(request("GPTBOT/1.2")))?.status).toBe(403);
		expect((await serve(request("gptbot/1.2")))?.status).toBe(403);
	});

	it("blocks a token written with capitals in the rules file", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["GPTBot"] })]),
		);
		expect((await serve(request(GPTBOT_UA)))?.status).toBe(403);
	});

	it("blocks a token found anywhere in the user agent", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["openai.com/gptbot"] })]),
		);
		expect((await serve(request(GPTBOT_UA)))?.status).toBe(403);
	});

	it("does not block a user agent that only shares part of the token", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["gptbot/2"] })]),
		);
		expect(await serve(request(GPTBOT_UA))).toBeNull();
	});

	it("does not block a sibling agent whose name holds a shorter blocked name", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["oai-searchbot"] })]),
		);
		expect(await serve(request(GPTBOT_UA))).toBeNull();
		expect((await serve(request(CHATGPT_USER_UA)))?.status).toBe(200);
	});

	it("blocks when any one of several tokens matches", async () => {
		const { serve } = await setup(
			siteRules([
				site({ blockedUserAgentTokens: ["claudebot", "gptbot", "bytespider"] }),
			]),
		);
		expect((await serve(request(GPTBOT_UA)))?.status).toBe(403);
		expect((await serve(request("Bytespider")))?.status).toBe(403);
		expect(await serve(request(CHROME_UA))).toBeNull();
	});
});

describe("serveAgentPage blocking: per hostname", () => {
	const twoSites = () =>
		siteRules([
			site({ hostname: HOST, blockedUserAgentTokens: [] }),
			site({
				hostname: DOCS,
				blockedUserAgentTokens: ["gptbot"],
				agentPages: { enabled: false, paths: [] },
			}),
		]);

	it("blocks only on the site that lists the token", async () => {
		const { serve } = await setup(twoSites());
		expect(
			(await serve(request(GPTBOT_UA, { url: `https://${DOCS}/pricing` })))
				?.status,
		).toBe(403);
		expect(await serve(request(GPTBOT_UA))).toBeNull();
	});

	it("does not block on a hostname the rules do not list", async () => {
		const { serve } = await setup(twoSites());
		expect(
			await serve(request(GPTBOT_UA, { url: "https://example.com/pricing" })),
		).toBeNull();
		expect(
			await serve(request(GPTBOT_UA, { url: `https://api.${DOCS}/pricing` })),
		).toBeNull();
	});

	it("matches the hostname whatever its case on either side", async () => {
		const { serve } = await setup(
			siteRules([site({ hostname: "Docs.Example.COM" })]),
		);
		const response = await serve(
			request(GPTBOT_UA, { url: "https://DOCS.EXAMPLE.com:8443/x" }),
		);
		expect(response?.status).toBe(403);
	});
});

describe("serveAgentPage blocking: the rules file", () => {
	it.each([
		["missing", undefined],
		["null", null],
		["empty", []],
	])("blocks nobody when the token list is %s", async (_name, tokens) => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: tokens })]),
		);
		expect(await serve(request(GPTBOT_UA))).toBeNull();
		expect((await serve(request(CHATGPT_USER_UA)))?.status).toBe(200);
	});

	it("drops an empty token instead of blocking every request", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: [""] })]),
		);
		expect(await serve(request(CHROME_UA))).toBeNull();
		expect(await serve(request(GPTBOT_UA))).toBeNull();
		expect((await serve(request(CHATGPT_USER_UA)))?.status).toBe(200);
	});

	it("keeps the real tokens next to an empty one", async () => {
		const { serve } = await setup(
			siteRules([site({ blockedUserAgentTokens: ["", "gptbot", ""] })]),
		);
		expect((await serve(request(GPTBOT_UA)))?.status).toBe(403);
		expect(await serve(request(CHROME_UA))).toBeNull();
	});

	it.each([
		["a string", "gptbot"],
		["a number in the list", ["gptbot", 1]],
		["a null in the list", [null]],
		["an object", { gptbot: true }],
	])(
		"rejects the whole rules file when the tokens are %s",
		async (_name, tokens) => {
			const { serve, pageFetched } = await setup(
				siteRules([
					site({ hostname: DOCS, blockedUserAgentTokens: ["claudebot"] }),
					site({ blockedUserAgentTokens: tokens }),
				]),
			);
			expect(await serve(request(GPTBOT_UA))).toBeNull();
			expect(await serve(request(CHATGPT_USER_UA))).toBeNull();
			expect(
				await serve(
					request("ClaudeBot/1.0", { url: `https://${DOCS}/pricing` }),
				),
			).toBeNull();
			expect(pageFetched()).toBe(false);
		},
	);

	it.each([
		["a 500", () => new Response(null, { status: 500 })],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
		["invalid JSON", () => new Response("{", { status: 200 })],
	])(
		"lets a blocked agent through when the rules fail with %s",
		async (_name, handler) => {
			const { serve } = await setup(siteRules(), { [RULES_URL]: handler });
			expect(await serve(request(GPTBOT_UA))).toBeNull();
		},
	);
});
