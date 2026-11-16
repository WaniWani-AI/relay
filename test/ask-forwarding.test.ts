import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest } from "../src/index";
import {
	API_URL,
	freshRelay,
	type Handler,
	INGEST_TOKEN,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/rules`;
const BOT_LIST_URL = `${API_URL}/api/v2/agent-traffic/rules`;
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const SITE_URL = `${PAGES_URL}/${HOST}`;
const ASK_URL = `${SITE_URL}/ask`;
const ORIGIN_HOST = "origin-bucket.s3.amazonaws.com";
const PREFIX = "/__waniwani-agent/";

const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const ASK_ANSWER = JSON.stringify({ _meta: { version: "0.55" }, results: [] });
const ASK_BODY = JSON.stringify({ query: "What does it cost?" });

const JSON_FILES = [
	"/.well-known/ai-catalog.json",
	"/openapi.json",
	"/.well-known/mcp.json",
	"/.well-known/mcp/server-card.json",
];

function siteRules() {
	return {
		version: 1,
		pagesUrl: PAGES_URL,
		userAgentTokens: ["chatgpt-user", "claude-user"],
		deadlines: { headersMs: 50, bodyMs: 50 },
		maxBodyBytes: 4096,
		sites: [
			{
				hostname: HOST,
				blockedUserAgentTokens: ["gptbot"],
				agentPages: {
					enabled: true,
					paths: ["/", "/pricing", "/ask", "/llms.txt", ...JSON_FILES],
				},
			},
		],
	};
}

const rulesAnswer: Handler = () =>
	Response.json({ success: true, message: "success", data: siteRules() });

const answer =
	(
		body: string | null = ASK_ANSWER,
		init: { status?: number; headers?: Record<string, string> } = {},
	): Handler =>
	() =>
		new Response(body, {
			status: init.status ?? 200,
			headers: { "content-type": "application/json", ...init.headers },
		});

const textAnswer = (body: string): Handler =>
	answer(body, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});

async function setup(routes: Record<string, Handler>) {
	const relay = await freshRelay();
	const stub = stubFetch({
		[RULES_URL]: rulesAnswer,
		[BOT_LIST_URL]: () => new Response(null, { status: 503 }),
		...routes,
	});
	const options = { key: KEY, apiUrl: API_URL };
	const serve = (request: Request) => relay.serveAgentPage(request, options);
	const serveCloudFront = (request: CloudFrontRequest) =>
		relay.serveAgentPage(request, options);
	const view = (request: CloudFrontRequest) =>
		relay.handleViewerRequest(request, options);
	const pageCalls = () =>
		stub.calls.filter((call) => call.url.startsWith(`${PAGES_URL}/`));
	return { ...stub, relay, serve, serveCloudFront, view, pageCalls };
}

function agentRequest(
	path: string,
	init: {
		method?: string;
		body?: BodyInit;
		headers?: Record<string, string>;
	} = {},
) {
	return new Request(`https://${HOST}${path}`, {
		method: init.method ?? "GET",
		body: init.body,
		headers: { "user-agent": CHATGPT_USER_UA, ...init.headers },
	});
}

const sentHeaders = (call: { init: RequestInit | undefined } | undefined) =>
	new Headers(call?.init?.headers);

const sentText = (call: { init: RequestInit | undefined } | undefined) =>
	new TextDecoder().decode(call?.init?.body as Uint8Array);

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("serveAgentPage: the query string", () => {
	it("forwards GET /ask with its query to the service and passes the JSON answer on", async () => {
		const url = `${ASK_URL}?query=price&limit=3`;
		const { serve, pageCalls } = await setup({ [url]: answer() });
		const response = await serve(agentRequest("/ask?query=price&limit=3"));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("application/json");
		expect(await response?.text()).toBe(ASK_ANSWER);
		expect(pageCalls().map((call) => call.url)).toEqual([url]);
		expect(pageCalls()[0]?.init?.method).toBeUndefined();
	});

	it("forwards ?goal= and need on llms.txt", async () => {
		const url = `${SITE_URL}/llms.txt?goal=pricing&need=quote`;
		const { serve } = await setup({ [url]: textAnswer("# Site") });
		const response = await serve(
			agentRequest("/llms.txt?goal=pricing&need=quote"),
		);
		expect(await response?.text()).toBe("# Site");
	});

	it("fetches each query string on its own, so one answer never serves another query", async () => {
		const { serve, pageCalls } = await setup({
			[`${ASK_URL}?query=a`]: answer('{"q":"a"}'),
			[`${ASK_URL}?query=b`]: answer('{"q":"b"}'),
		});
		expect(await (await serve(agentRequest("/ask?query=a")))?.text()).toBe(
			'{"q":"a"}',
		);
		expect(await (await serve(agentRequest("/ask?query=b")))?.text()).toBe(
			'{"q":"b"}',
		);
		expect(pageCalls().map((call) => call.url)).toEqual([
			`${ASK_URL}?query=a`,
			`${ASK_URL}?query=b`,
		]);
	});
});

describe("serveAgentPage: the agent header", () => {
	it("sends the user agent as it came in x-waniwani-agent", async () => {
		const { serve, pageCalls } = await setup({
			[`${SITE_URL}/pricing`]: textAnswer("# Pricing"),
		});
		await serve(agentRequest("/pricing"));
		expect(sentHeaders(pageCalls()[0]).get("x-waniwani-agent")).toBe(
			CHATGPT_USER_UA,
		);
	});

	it("sends no x-waniwani-agent when the client sends no user agent", async () => {
		const { serve, pageCalls } = await setup({
			[`${SITE_URL}/pricing`]: textAnswer("# Pricing"),
		});
		const response = await serve(
			new Request(`https://${HOST}/pricing`, {
				headers: { accept: "text/markdown" },
			}),
		);
		expect(response?.status).toBe(200);
		expect(sentHeaders(pageCalls()[0]).has("x-waniwani-agent")).toBe(false);
	});
});

describe("serveAgentPage: POST /ask", () => {
	it("forwards the body as a POST and leaves the request body for the origin", async () => {
		const { serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		const request = agentRequest("/ask", { method: "POST", body: ASK_BODY });
		const response = await serve(request);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe(ASK_ANSWER);
		const call = pageCalls()[0];
		expect(call?.init?.method).toBe("POST");
		expect(sentText(call)).toBe(ASK_BODY);
		expect(sentHeaders(call).get("content-type")).toBe("application/json");
		expect(sentHeaders(call).get("x-waniwani-agent")).toBe(CHATGPT_USER_UA);
		expect(await request.text()).toBe(ASK_BODY);
	});

	it("forwards a body of exactly the cap", async () => {
		const { relay, serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		const body = "x".repeat(relay.settings.askMaxBodyBytes);
		const response = await serve(
			agentRequest("/ask", { method: "POST", body }),
		);
		expect(response?.status).toBe(200);
		expect(sentText(pageCalls()[0])).toHaveLength(body.length);
	});

	it("gives a body over the cap to the origin and never forwards it", async () => {
		const { relay, serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		const body = "x".repeat(relay.settings.askMaxBodyBytes + 1);
		const request = agentRequest("/ask", { method: "POST", body });
		expect(await serve(request)).toBeNull();
		expect(pageCalls()).toEqual([]);
		expect(await request.text()).toBe(body);
	});

	it("gives a streamed body over the cap with no content-length to the origin", async () => {
		const { relay, serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		const chunk = new Uint8Array(relay.settings.askMaxBodyBytes / 2 + 1);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const request = new Request(`https://${HOST}/ask`, {
			method: "POST",
			body,
			headers: { "user-agent": CHATGPT_USER_UA },
			duplex: "half",
		} as RequestInit);
		expect(request.headers.has("content-length")).toBe(false);
		expect(await serve(request)).toBeNull();
		expect(pageCalls()).toEqual([]);
	});

	it("gives an empty POST to the origin", async () => {
		const { serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		expect(await serve(agentRequest("/ask", { method: "POST" }))).toBeNull();
		expect(pageCalls()).toEqual([]);
	});

	it.each(["/pricing", "/llms.txt", "/", "/ask/more"])(
		"gives POST %s to the origin with no page fetch",
		async (path) => {
			const { serve, pageCalls } = await setup({
				[`${SITE_URL}${path}`]: textAnswer("# Page"),
			});
			expect(
				await serve(agentRequest(path, { method: "POST", body: ASK_BODY })),
			).toBeNull();
			expect(pageCalls()).toEqual([]);
		},
	);

	it.each(["PUT", "PATCH", "DELETE"])(
		"gives %s /ask to the origin",
		async (method) => {
			const { serve, pageCalls } = await setup({ [ASK_URL]: answer() });
			expect(
				await serve(agentRequest("/ask", { method, body: ASK_BODY })),
			).toBeNull();
			expect(pageCalls()).toEqual([]);
		},
	);

	it("answers a blocked agent with 403 and forwards nothing", async () => {
		const { serve, pageCalls } = await setup({ [ASK_URL]: answer() });
		const response = await serve(
			agentRequest("/ask", {
				method: "POST",
				body: ASK_BODY,
				headers: { "user-agent": GPTBOT_UA },
			}),
		);
		expect(response?.status).toBe(403);
		expect(pageCalls()).toEqual([]);
	});

	it("gives a browser's POST /ask to the origin without reading the rules", async () => {
		const { serve, calls } = await setup({ [ASK_URL]: answer() });
		const response = await serve(
			agentRequest("/ask", {
				method: "POST",
				body: ASK_BODY,
				headers: { "user-agent": CHROME_UA },
			}),
		);
		expect(response).toBeNull();
		expect(calls).toEqual([]);
	});
});

describe("serveAgentPage: answers that are not a 200", () => {
	it("passes a 429 for /ask on with its Retry-After and body", async () => {
		const body = '{"error":{"code":"RATE_LIMITED"}}';
		const { serve } = await setup({
			[`${ASK_URL}?query=a`]: answer(body, {
				status: 429,
				headers: { "retry-after": "17" },
			}),
		});
		const response = await serve(agentRequest("/ask?query=a"));
		expect(response?.status).toBe(429);
		expect(response?.headers.get("retry-after")).toBe("17");
		expect(response?.headers.get("content-type")).toBe("application/json");
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(await response?.text()).toBe(body);
	});

	it("passes a 429 for POST /ask on", async () => {
		const { serve } = await setup({
			[ASK_URL]: answer(null, { status: 429, headers: { "retry-after": "5" } }),
		});
		const response = await serve(
			agentRequest("/ask", { method: "POST", body: ASK_BODY }),
		);
		expect(response?.status).toBe(429);
		expect(response?.headers.get("retry-after")).toBe("5");
		expect(response?.headers.has("content-type")).toBe(false);
		expect(await response?.text()).toBe("");
	});

	it("answers HEAD /ask that the service limits with a 429 and no body", async () => {
		const { serve } = await setup({
			[ASK_URL]: answer("{}", { status: 429, headers: { "retry-after": "5" } }),
		});
		const response = await serve(agentRequest("/ask", { method: "HEAD" }));
		expect(response?.status).toBe(429);
		expect(response?.body).toBeNull();
	});

	it("falls back to the origin on a 429 for a page", async () => {
		const { serve } = await setup({
			[`${SITE_URL}/pricing`]: answer("# Pricing", {
				status: 429,
				headers: {
					"content-type": "text/markdown",
					"retry-after": "5",
				},
			}),
		});
		expect(await serve(agentRequest("/pricing"))).toBeNull();
	});

	it.each([400, 404, 500, 503])(
		"falls back to the origin on a %i for /ask",
		async (status) => {
			const { serve } = await setup({
				[`${ASK_URL}?query=a`]: answer("{}", {
					status,
					headers: { "retry-after": "30" },
				}),
				[ASK_URL]: answer("{}", { status }),
			});
			expect(await serve(agentRequest("/ask?query=a"))).toBeNull();
			expect(
				await serve(agentRequest("/ask", { method: "POST", body: ASK_BODY })),
			).toBeNull();
		},
	);
});

describe("serveAgentPage: content types", () => {
	it.each(JSON_FILES)("serves application/json for %s", async (path) => {
		const { serve } = await setup({ [`${SITE_URL}${path}`]: answer("{}") });
		const response = await serve(agentRequest(path));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe("application/json");
	});

	it("serves application/json with a charset for /ask", async () => {
		const { serve } = await setup({
			[`${ASK_URL}?query=a`]: answer("{}", {
				headers: { "content-type": "Application/JSON; charset=utf-8" },
			}),
		});
		expect((await serve(agentRequest("/ask?query=a")))?.status).toBe(200);
	});

	it("still serves text/plain for /ask", async () => {
		const { serve } = await setup({
			[`${ASK_URL}?query=a`]: textAnswer(ASK_ANSWER),
		});
		expect(await (await serve(agentRequest("/ask?query=a")))?.text()).toBe(
			ASK_ANSWER,
		);
	});

	it.each(["/pricing", "/llms.txt", "/"])(
		"falls back to the origin when %s answers application/json",
		async (path) => {
			const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;
			const { serve } = await setup({ [url]: answer("{}") });
			expect(await serve(agentRequest(path))).toBeNull();
		},
	);

	it.each(["application/javascript", "application/json-seq", "image/png"])(
		"falls back to the origin when /ask answers %s",
		async (contentType) => {
			const { serve } = await setup({
				[`${ASK_URL}?query=a`]: answer("{}", {
					headers: { "content-type": contentType },
				}),
			});
			expect(await serve(agentRequest("/ask?query=a"))).toBeNull();
		},
	);
});

const header = (key: string, value: string) => [{ key, value }];

function viewerRequest(
	init: {
		method?: string;
		uri?: string;
		querystring?: string;
		userAgent?: string;
	} = {},
): CloudFrontRequest {
	return {
		clientIp: "198.51.100.23",
		method: init.method ?? "GET",
		uri: init.uri ?? "/ask",
		querystring: init.querystring ?? "",
		headers: {
			host: header("Host", HOST),
			"user-agent": header("User-Agent", init.userAgent ?? CHATGPT_USER_UA),
		},
	};
}

/** CloudFront replaces the viewer `Host` and `User-Agent`, and with the `CachingOptimized` policy forwards no query string. */
function toOrigin(
	viewer: CloudFrontRequest,
	body?: CloudFrontRequest["body"],
): CloudFrontRequest {
	const origin: CloudFrontRequest = {
		...viewer,
		querystring: "",
		headers: {
			host: header("Host", ORIGIN_HOST),
			"user-agent": header("User-Agent", "Amazon CloudFront"),
		},
	};
	if (body) {
		origin.body = body;
	}
	return origin;
}

const base64 = (text: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const askBody = (
	data = base64(ASK_BODY),
	overrides: Partial<NonNullable<CloudFrontRequest["body"]>> = {},
): CloudFrontRequest["body"] => ({
	inputTruncated: false,
	action: "read-only",
	encoding: "base64",
	data,
	...overrides,
});

describe("CloudFront: the query string and the agent", () => {
	it("carries the query and the user agent in the mark, so the origin request has both", async () => {
		const url = `${ASK_URL}?query=price%20plans&limit=3`;
		const { view, serveCloudFront, pageCalls } = await setup({
			[url]: answer(),
		});
		const viewer = viewerRequest({
			querystring: "query=price%20plans&limit=3",
		});
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe(
			`${PREFIX}html;${encodeURIComponent("query=price%20plans&limit=3")};${encodeURIComponent(CHATGPT_USER_UA)}/${HOST}/ask`,
		);
		expect(viewer.querystring).toBe("query=price%20plans&limit=3");

		const origin = toOrigin(viewer);
		const result = await serveCloudFront(origin);
		expect(result?.status).toBe("200");
		expect(result?.body).toBe(ASK_ANSWER);
		expect(result?.headers["content-type"]).toEqual([
			{ key: "Content-Type", value: "application/json" },
		]);
		expect(origin.uri).toBe("/ask");
		expect(pageCalls().map((call) => call.url)).toEqual([url]);
		expect(sentHeaders(pageCalls()[0]).get("x-waniwani-agent")).toBe(
			CHATGPT_USER_UA,
		);
	});

	it("gives each query string its own mark, so CloudFront keys them apart", async () => {
		const { view } = await setup({});
		const a = viewerRequest({ querystring: "query=a" });
		const b = viewerRequest({ querystring: "query=b" });
		await view(a);
		await view(b);
		expect(a.uri.startsWith(PREFIX)).toBe(true);
		expect(b.uri.startsWith(PREFIX)).toBe(true);
		expect(a.uri).not.toBe(b.uri);
	});

	it("leaves the query string the origin gets unchanged when the page falls back", async () => {
		const { view, serveCloudFront } = await setup({
			[`${ASK_URL}?query=a`]: answer("{}", { status: 500 }),
		});
		const viewer = viewerRequest({ querystring: "query=a" });
		await view(viewer);
		const origin = { ...toOrigin(viewer), querystring: "kept=1" };
		expect(await serveCloudFront(origin)).toBeNull();
		expect(origin.uri).toBe("/ask");
		expect(origin.querystring).toBe("kept=1");
	});

	it("serves a mark from relay 0.6.0 with the query string CloudFront forwards and no agent", async () => {
		const url = `${SITE_URL}/pricing?plan=team`;
		const { serveCloudFront, pageCalls } = await setup({
			[url]: textAnswer("# Pricing"),
		});
		const result = await serveCloudFront({
			...toOrigin(viewerRequest()),
			uri: `${PREFIX}html/${HOST}/pricing`,
			querystring: "plan=team",
		});
		expect(result?.body).toBe("# Pricing");
		expect(pageCalls().map((call) => call.url)).toEqual([url]);
		expect(sentHeaders(pageCalls()[0]).has("x-waniwani-agent")).toBe(false);
	});

	it.each([
		`${PREFIX}html;a/${HOST}/ask`,
		`${PREFIX}html;a;b;c/${HOST}/ask`,
		`${PREFIX}html;%E0%A4%A;x/${HOST}/ask`,
	])(
		"gives a malformed mark %s to the origin at the real path",
		async (uri) => {
			const { serveCloudFront, pageCalls } = await setup({});
			const origin = { ...toOrigin(viewerRequest()), uri };
			expect(await serveCloudFront(origin)).toBeNull();
			expect(origin.uri).toBe("/ask");
			expect(pageCalls()).toEqual([]);
		},
	);

	it("strips a mark a client forged with its own query", async () => {
		const { view } = await setup({});
		const viewer = viewerRequest({
			uri: `${PREFIX}html;evil;evil/${HOST}/ask`,
			querystring: "query=a",
		});
		await view(viewer);
		expect(viewer.uri).toBe(
			`${PREFIX}html;${encodeURIComponent("query=a")};${encodeURIComponent(CHATGPT_USER_UA)}/${HOST}/ask`,
		);
	});
});

describe("CloudFront: POST /ask", () => {
	it("marks POST /ask at viewer request and forwards the body at origin request", async () => {
		const { view, serveCloudFront, pageCalls } = await setup({
			[ASK_URL]: answer(),
		});
		const viewer = viewerRequest({ method: "POST" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri.startsWith(PREFIX)).toBe(true);

		const result = await serveCloudFront(toOrigin(viewer, askBody()));
		expect(result?.status).toBe("200");
		expect(result?.body).toBe(ASK_ANSWER);
		const call = pageCalls()[0];
		expect(call?.init?.method).toBe("POST");
		expect(sentText(call)).toBe(ASK_BODY);
		expect(sentHeaders(call).get("x-waniwani-agent")).toBe(CHATGPT_USER_UA);
	});

	it("forwards a body that CloudFront passes as text", async () => {
		const { view, serveCloudFront, pageCalls } = await setup({
			[ASK_URL]: answer(),
		});
		const viewer = viewerRequest({ method: "POST" });
		await view(viewer);
		const text = JSON.stringify({ query: "Prix en €" });
		await serveCloudFront(
			toOrigin(viewer, askBody(text, { encoding: "text" })),
		);
		expect(sentText(pageCalls()[0])).toBe(text);
	});

	it.each([
		["no body, because Include body is off", undefined],
		[
			"a body CloudFront cut",
			askBody(base64(ASK_BODY), { inputTruncated: true }),
		],
		["an empty body", askBody("")],
		["a body that is not base64", askBody("!!!")],
	])("gives %s to the origin at the real path", async (_name, body) => {
		const { view, serveCloudFront, pageCalls } = await setup({
			[ASK_URL]: answer(),
		});
		const viewer = viewerRequest({ method: "POST" });
		await view(viewer);
		const origin = toOrigin(viewer, body);
		expect(await serveCloudFront(origin)).toBeNull();
		expect(origin.uri).toBe("/ask");
		expect(pageCalls()).toEqual([]);
	});

	it("gives a body over the cap to the origin and never forwards it", async () => {
		const { relay, view, serveCloudFront, pageCalls } = await setup({
			[ASK_URL]: answer(),
		});
		const viewer = viewerRequest({ method: "POST" });
		await view(viewer);
		const big = "x".repeat(relay.settings.askMaxBodyBytes + 1);
		const origin = toOrigin(viewer, askBody(big, { encoding: "text" }));
		expect(await serveCloudFront(origin)).toBeNull();
		expect(origin.uri).toBe("/ask");
		expect(pageCalls()).toEqual([]);
	});

	it("leaves POST /pricing unmarked", async () => {
		const { view, calls } = await setup({});
		const viewer = viewerRequest({ method: "POST", uri: "/pricing" });
		expect(await view(viewer)).toBeNull();
		expect(viewer.uri).toBe("/pricing");
		expect(calls).toEqual([]);
	});

	it("gives a marked POST for a page path to the origin", async () => {
		const { serveCloudFront, pageCalls } = await setup({
			[`${SITE_URL}/pricing`]: textAnswer("# Pricing"),
		});
		const origin = {
			...toOrigin(viewerRequest({ method: "POST" }), askBody()),
			uri: `${PREFIX}html;;/${HOST}/pricing`,
		};
		expect(await serveCloudFront(origin)).toBeNull();
		expect(origin.uri).toBe("/pricing");
		expect(pageCalls()).toEqual([]);
	});

	it("answers a blocked agent with 403 at viewer request", async () => {
		const { view } = await setup({});
		const result = await view(
			viewerRequest({ method: "POST", userAgent: GPTBOT_UA }),
		);
		expect(result?.status).toBe("403");
		expect(result?.body).toBe("Forbidden");
	});

	it("passes a 429 on with its Retry-After", async () => {
		const { view, serveCloudFront } = await setup({
			[ASK_URL]: answer('{"error":"slow down"}', {
				status: 429,
				headers: { "retry-after": "12" },
			}),
		});
		const viewer = viewerRequest({ method: "POST" });
		await view(viewer);
		const result = await serveCloudFront(toOrigin(viewer, askBody()));
		expect(result?.status).toBe("429");
		expect(result?.statusDescription).toBe("Too Many Requests");
		expect(result?.headers["retry-after"]).toEqual([
			{ key: "Retry-After", value: "12" },
		]);
		expect(result?.body).toBe('{"error":"slow down"}');
	});

	it("falls back to the origin on a 500", async () => {
		const { view, serveCloudFront } = await setup({
			[ASK_URL]: answer("{}", { status: 500 }),
		});
		const viewer = viewerRequest({ method: "POST" });
		await view(viewer);
		const origin = toOrigin(viewer, askBody());
		expect(await serveCloudFront(origin)).toBeNull();
		expect(origin.uri).toBe("/ask");
	});
});
