import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest } from "../src/index";
import {
	API_URL,
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
const ORIGIN_HOST = "origin-bucket.s3.amazonaws.com";
const PRICING_URL = `${PAGES_URL}/${HOST}/pricing`;
const PREFIX = "/__waniwani-agent/";
const PERSON_IP = "198.51.100.23";

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

const siteRules = (sites: Site[] = [site()]) => ({
	version: 1,
	pagesUrl: PAGES_URL,
	userAgentTokens: ["chatgpt-user", "claude-user"],
	deadlines: { headersMs: 50, bodyMs: 50 },
	maxBodyBytes: 64,
	sites,
});

const rulesAnswer =
	(data: unknown = siteRules()): Handler =>
	() =>
		Response.json({ success: true, message: "success", data });

const markdownPage: Handler = () =>
	new Response("# Pricing", {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});

const header = (key: string, value: string) => [{ key, value }];

function viewerRequest(
	init: {
		userAgent?: string | null;
		accept?: string;
		method?: string;
		uri?: string;
		headers?: CloudFrontRequest["headers"];
	} = {},
): CloudFrontRequest {
	const userAgent = init.userAgent === undefined ? CHROME_UA : init.userAgent;
	return {
		clientIp: PERSON_IP,
		method: init.method ?? "GET",
		uri: init.uri ?? "/pricing",
		querystring: "",
		headers: {
			host: header("Host", HOST),
			...(userAgent === null
				? {}
				: { "user-agent": header("User-Agent", userAgent) }),
			...(init.accept === undefined
				? {}
				: { accept: header("Accept", init.accept) }),
			...init.headers,
		},
	};
}

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

const markedAs = (format: "markdown" | "html", path = "/pricing") =>
	`${PREFIX}${format}/${HOST}${path}`;

async function setup(routes: Record<string, Handler> = {}) {
	const relay = await freshRelay();
	const stub = stubFetch({
		[RULES_URL]: rulesAnswer(),
		[PRICING_URL]: markdownPage,
		[BOT_LIST_URL]: () => new Response(null, { status: 503 }),
		[INGEST_URL]: () => new Response(null, { status: 202 }),
		...routes,
	});
	const options = { key: KEY, apiUrl: API_URL };
	const view = (request: CloudFrontRequest) =>
		relay.handleViewerRequest(request, options);
	const serve = (request: CloudFrontRequest) =>
		relay.serveAgentPage(request, options);
	const rulesLoads = () =>
		stub.calls.filter((call) => call.url === RULES_URL).length;
	const acceptSentUpstream = () =>
		stub.calls
			.filter((call) => call.url.startsWith(PAGES_URL))
			.map((call) => new Headers(call.init?.headers).get("accept"));
	return {
		...stub,
		relay,
		options,
		view,
		serve,
		rulesLoads,
		acceptSentUpstream,
	};
}

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("CloudFront: a person who prefers Markdown", () => {
	it("is marked for the Markdown page at viewer request and served it at origin request", async () => {
		const { view, serve, acceptSentUpstream } = await setup();
		const viewer = viewerRequest({ accept: "text/markdown" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe(markedAs("markdown"));

		const origin = toOrigin(viewer);
		const result = await serve(origin);
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
		expect(origin.uri).toBe("/pricing");
		expect(acceptSentUpstream()).toEqual(["text/markdown"]);
	});

	it.each([
		["curl", CURL_UA, "text/markdown, */*;q=0.1"],
		["no user agent", null, "text/markdown"],
		["Markdown ranked first", FIREFOX_UA, "text/markdown, text/html;q=0.9"],
		["a tie with HTML", SAFARI_UA, "text/html, text/markdown"],
	])("marks %s for the Markdown page", async (_name, userAgent, accept) => {
		const { view } = await setup();
		const viewer = viewerRequest({ userAgent, accept });
		await view(viewer);
		expect(viewer.uri).toBe(markedAs("markdown"));
	});

	it("marks HEAD the same as GET", async () => {
		const { view } = await setup();
		const viewer = viewerRequest({ accept: "text/markdown", method: "HEAD" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe(markedAs("markdown"));
	});

	it.each(["POST", "PUT", "DELETE", "OPTIONS"])(
		"leaves %s unmarked without loading the site rules",
		async (method) => {
			const { view, rulesLoads } = await setup();
			const viewer = viewerRequest({ accept: "text/markdown", method });
			expect(await view(viewer)).toBeNull();
			expect(viewer.uri).toBe("/pricing");
			expect(rulesLoads()).toBe(0);
		},
	);

	it("leaves the renderer's own request unmarked", async () => {
		const { view } = await setup();
		const viewer = viewerRequest({
			accept: "text/markdown",
			headers: { "x-waniwani-render": header("X-Waniwani-Render", "1") },
		});
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/pricing");
	});

	it("leaves the request unmarked when agent pages are off", async () => {
		const { view } = await setup({
			[RULES_URL]: rulesAnswer(
				siteRules([site({ agentPages: { enabled: false, paths: ["*"] } })]),
			),
		});
		const viewer = viewerRequest({ accept: "text/markdown" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/pricing");
	});

	it("leaves a path that is not an agent page unmarked", async () => {
		const { view } = await setup();
		const viewer = viewerRequest({ accept: "text/markdown", uri: "/blog" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/blog");
	});

	it("falls through to the origin when the stored page is missing", async () => {
		const { view, serve } = await setup({
			[PRICING_URL]: () => new Response("missing", { status: 404 }),
		});
		const viewer = viewerRequest({ accept: "text/markdown" });
		await view(viewer);
		const origin = toOrigin(viewer);
		expect(await serve(origin)).toBeNull();
		expect(origin.uri).toBe("/pricing");
	});
});

describe("CloudFront: a person who does not prefer Markdown", () => {
	it.each([
		["Chrome", CHROME_UA, CHROME_ACCEPT],
		["Safari", SAFARI_UA, SAFARI_ACCEPT],
		["Firefox", FIREFOX_UA, FIREFOX_ACCEPT],
		["curl", CURL_UA, "*/*"],
		["no Accept header", CHROME_UA, undefined],
		["an empty Accept header", CHROME_UA, ""],
		["Markdown ranked below HTML", CHROME_UA, "text/html, text/markdown;q=0.5"],
		["Markdown refused", CURL_UA, "text/markdown;q=0"],
	])(
		"leaves %s unmarked without loading the site rules",
		async (_name, userAgent, accept) => {
			const { view, rulesLoads } = await setup();
			const viewer = viewerRequest({ userAgent, accept });
			expect(await view(viewer)).toBeNull();
			expect(viewer.uri).toBe("/pricing");
			expect(rulesLoads()).toBe(0);
		},
	);

	it("strips a forged Markdown mark from a browser and loads nothing", async () => {
		const { view, rulesLoads } = await setup();
		const viewer = viewerRequest({
			accept: CHROME_ACCEPT,
			uri: markedAs("markdown"),
		});
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/pricing");
		expect(rulesLoads()).toBe(0);
	});

	it("reads every Accept header line CloudFront passes, not only the first", async () => {
		const { view } = await setup();
		const viewer = viewerRequest({
			headers: {
				accept: [
					{ key: "Accept", value: "text/markdown;q=0.5" },
					{ key: "Accept", value: "text/html" },
				],
			},
		});
		await view(viewer);
		expect(viewer.uri).toBe("/pricing");
	});
});

describe("CloudFront: blocked tokens and a client that prefers Markdown", () => {
	const blocksCurl = () => ({
		[RULES_URL]: rulesAnswer(
			siteRules([site({ blockedUserAgentTokens: ["curl"] })]),
		),
	});

	it("answers 403 at viewer request", async () => {
		const { view, acceptSentUpstream } = await setup(blocksCurl());
		const viewer = viewerRequest({
			userAgent: CURL_UA,
			accept: "text/markdown",
		});
		const result = await view(viewer);
		expect(result?.status).toBe("403");
		expect(result?.body).toBe("Forbidden");
		expect(result?.headers).toEqual({
			"content-type": [
				{ key: expect.any(String), value: "text/plain; charset=utf-8" },
			],
			"x-waniwani-blocked": [{ key: expect.any(String), value: "1" }],
			"cache-control": [
				{ key: expect.any(String), value: "private, no-store" },
			],
			vary: [{ key: expect.any(String), value: "user-agent" }],
		});
		expect(viewer.uri).toBe("/pricing");
		expect(acceptSentUpstream()).toEqual([]);
	});

	it("answers HEAD with the 403 and no body", async () => {
		const { view } = await setup(blocksCurl());
		const result = await view(
			viewerRequest({
				userAgent: CURL_UA,
				accept: "text/markdown",
				method: "HEAD",
			}),
		);
		expect(result?.status).toBe("403");
		expect(result?.body).toBeUndefined();
	});

	it("lets the same user agent through unmarked without loading the rules when it asks for anything", async () => {
		const { view, rulesLoads } = await setup(blocksCurl());
		const viewer = viewerRequest({ userAgent: CURL_UA, accept: "*/*" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/pricing");
		expect(rulesLoads()).toBe(0);
	});
});

describe("CloudFront: AI agents keep their behavior", () => {
	it.each([
		["text/html, text/markdown;q=0.5", "markdown"],
		["text/markdown", "markdown"],
		["text/html", "html"],
		["*/*", "html"],
		["text/markdown;q=0", "html"],
		[undefined, "html"],
	] as const)(
		"marks a user-acting agent with Accept %j for the %s page",
		async (accept, format) => {
			const { view } = await setup();
			const viewer = viewerRequest({ userAgent: CHATGPT_USER_UA, accept });
			await view(viewer);
			expect(viewer.uri).toBe(markedAs(format));
		},
	);

	it.each([
		["text/markdown", markedAs("markdown")],
		["text/html", "/pricing"],
		["*/*", "/pricing"],
		["text/html, text/markdown;q=0.5", "/pricing"],
	])(
		"gives a training crawler with Accept %j the uri %s",
		async (accept, uri) => {
			const { view, rulesLoads } = await setup();
			const viewer = viewerRequest({ userAgent: CLAUDEBOT_UA, accept });
			await view(viewer);
			expect(viewer.uri).toBe(uri);
			expect(rulesLoads()).toBe(1);
		},
	);
});

describe("CloudFront: the viewer-request snippet records nothing for a person who prefers Markdown", () => {
	async function viewerHandler(
		relay: Awaited<ReturnType<typeof setup>>["relay"],
		request: CloudFrontRequest,
	) {
		const key = { key: KEY, apiUrl: API_URL };
		const visit = relay.isAgent(request, { apiUrl: API_URL })
			? relay.recordAgentVisit(request, key)
			: null;
		const answer = await relay.handleViewerRequest(request, key);
		await visit;
		return answer ?? request;
	}

	it("marks a browser that asks for Markdown and posts no event", async () => {
		const { relay, calls } = await setup();
		const viewer = viewerRequest({ accept: "text/markdown" });
		const result = await viewerHandler(relay, viewer);
		expect(result).toBe(viewer);
		expect(viewer.uri).toBe(markedAs("markdown"));
		expect(ingestBodies(calls)).toEqual([]);
		expect(calls.filter((call) => call.url.includes("/ingest/"))).toEqual([]);
	});

	it("posts one event with the original path for a user-acting agent", async () => {
		const { relay, calls } = await setup();
		const viewer = viewerRequest({
			userAgent: CHATGPT_USER_UA,
			accept: "text/markdown",
		});
		await viewerHandler(relay, viewer);
		expect(viewer.uri).toBe(markedAs("markdown"));
		const requests = ingestBodies(calls).flatMap((body) => body.requests);
		expect(requests).toHaveLength(1);
		expect(requests[0].path).toBe("/pricing");
	});
});
