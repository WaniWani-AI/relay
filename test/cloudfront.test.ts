import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest } from "../src/index";
import {
	API_URL,
	agentRequest,
	collector,
	freshRelay,
	type Handler,
	hang,
	INGEST_URL,
	ingestBodies,
	KEY,
	ORG_KEY,
	stubFetch,
} from "./helpers";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OPENAI_IP = "20.125.66.81";
const PERSON_IP = "198.51.100.23";

const ok = () => new Response(null, { status: 202 });
const status =
	(code: number): Handler =>
	() =>
		new Response(null, { status: code });
const networkError: Handler = () => {
	throw new TypeError("fetch failed");
};

const header = (key: string, value: string) => [{ key, value }];

function cfRequest(
	overrides: Partial<CloudFrontRequest> = {},
	extraHeaders: CloudFrontRequest["headers"] = {},
): CloudFrontRequest {
	return {
		clientIp: PERSON_IP,
		method: "GET",
		uri: "/pricing",
		querystring: "x=1&y=2",
		headers: {
			host: header("Host", "www.example.com"),
			"user-agent": header("User-Agent", GPTBOT_UA),
			...extraHeaders,
		},
		...overrides,
	};
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function recordAwaited(
	request: unknown,
	handler: Handler = ok,
	options: Record<string, unknown> = {},
) {
	const relay = await freshRelay();
	const { calls } = stubFetch({ [INGEST_URL]: handler });
	const result = relay.recordAgentVisit(JSON.parse(JSON.stringify(request)), {
		key: KEY,
		apiUrl: API_URL,
		...options,
	});
	await result;
	return { calls, bodies: ingestBodies(calls), relay, result };
}

const matchKeyOf = (ip: string) =>
	createHmac("sha256", ORG_KEY).update(ip).digest("hex");

describe("CloudFront: the event", () => {
	it("posts one record built from host, uri, querystring, method and clientIp", async () => {
		const { bodies } = await recordAwaited(
			cfRequest(
				{ method: "HEAD" },
				{ referer: header("Referer", "https://chatgpt.com/") },
			),
		);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].requests).toHaveLength(1);
		const record = bodies[0].requests[0];
		expect(record.method).toBe("HEAD");
		expect(record.host).toBe("www.example.com");
		expect(record.path).toBe("/pricing?x=1&y=2");
		expect(record.userAgent).toBe(GPTBOT_UA);
		expect(record.referer).toBe("https://chatgpt.com/");
		expect(record.platform).toBe("cloudfront");
		expect(record.matchKey).toBe(matchKeyOf(PERSON_IP));
		expect(record.headers).toEqual({
			"user-agent": GPTBOT_UA,
			referer: "https://chatgpt.com/",
		});
	});

	it("leaves out the question mark when the querystring is empty", async () => {
		const { bodies } = await recordAwaited(cfRequest({ querystring: "" }));
		expect(bodies[0].requests[0].path).toBe("/pricing");
	});

	it.each([
		["www.example.com:443", "www.example.com"],
		["www.example.com:8443", "www.example.com"],
		["www.example.com:80", "www.example.com"],
		["WWW.Example.COM", "www.example.com"],
		["WWW.Example.COM:443", "www.example.com"],
		["[2001:db8::1]:8443", "[2001:db8::1]"],
		["198.51.100.10", "198.51.100.10"],
	])("posts for the host header %s with host %s", async (value, host) => {
		const { bodies } = await recordAwaited(
			cfRequest({}, { host: header("Host", value) }),
		);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].requests[0].host).toBe(host);
		expect(bodies[0].requests[0].path).toBe("/pricing?x=1&y=2");
	});

	it.each([
		["", "empty"],
		["www.example.com/evil", "a path"],
		["www.example.com?x=1", "a query"],
		["www.example.com#frag", "a fragment"],
		["user@www.example.com", "userinfo"],
		["www example.com", "a space"],
		["www.example.com:99999", "a port out of range"],
	])(
		"posts nothing and resolves for the host header %j (%s)",
		async (value) => {
			const { bodies, result } = await recordAwaited(
				cfRequest({}, { host: header("Host", value) }),
			);
			await expect(result).resolves.toBeUndefined();
			expect(bodies).toHaveLength(0);
		},
	);

	it("posts nothing when the first host entry is malformed and a later one is fine", async () => {
		const { bodies } = await recordAwaited(
			cfRequest(
				{},
				{
					host: [
						{ key: "Host", value: "user@evil.example" },
						{ key: "Host", value: "www.example.com" },
					],
				},
			),
		);
		expect(bodies).toHaveLength(0);
	});

	it("never reads the cookie of a CloudFront request", async () => {
		const relay = await freshRelay();
		stubFetch({ [INGEST_URL]: ok });
		const request = cfRequest();
		let reads = 0;
		Object.defineProperty(request.headers, "cookie", {
			enumerable: true,
			get() {
				reads++;
				return header("Cookie", "session=SECRET_COOKIE");
			},
		});
		expect(relay.isAgent(request)).toBe(true);
		await relay.recordAgentVisit(request, { key: KEY, apiUrl: API_URL });
		expect(reads).toBe(0);
	});

	it("skips a refused header value and keeps the rest of the record", async () => {
		const { bodies } = await recordAwaited(
			cfRequest({}, { referer: header("Referer", "https://例え.jp/日本") }),
		);
		expect(bodies).toHaveLength(1);
		const record = bodies[0].requests[0];
		expect("referer" in record).toBe(false);
		expect(record.userAgent).toBe(GPTBOT_UA);
	});

	it("keeps the valid value of a user-agent whose first value is refused", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{},
					{
						"user-agent": [
							{ key: "User-Agent", value: "日本語" },
							{ key: "User-Agent", value: "GPTBot/1.2" },
						],
					},
				),
			),
		).toBe(true);
	});

	it("takes the match key from clientIp and never from a client-sent IP header", async () => {
		const { bodies, calls } = await recordAwaited(
			cfRequest(
				{ clientIp: PERSON_IP },
				{
					"x-forwarded-for": header("X-Forwarded-For", "203.0.113.7, 10.0.0.1"),
					"cf-connecting-ip": header("CF-Connecting-IP", "203.0.113.8"),
					"x-real-ip": header("X-Real-IP", "203.0.113.9"),
				},
			),
		);
		expect(bodies[0].requests[0].matchKey).toBe(matchKeyOf(PERSON_IP));
		const raw = String(calls[0]?.init?.body);
		expect(raw).not.toContain(PERSON_IP);
		expect(raw).not.toContain("203.0.113.7");
	});

	it("lowercases and trims an IPv6 clientIp before the match key", async () => {
		const { bodies } = await recordAwaited(
			cfRequest({ clientIp: " 2001:DB8::42 " }),
		);
		expect(bodies[0].requests[0].matchKey).toBe(matchKeyOf("2001:db8::42"));
	});

	it("omits the match key for an empty clientIp even with an x-forwarded-for", async () => {
		const { bodies } = await recordAwaited(
			cfRequest(
				{ clientIp: "" },
				{ "x-forwarded-for": header("X-Forwarded-For", "203.0.113.7") },
			),
		);
		expect(bodies).toHaveLength(1);
		expect("matchKey" in bodies[0].requests[0]).toBe(false);
	});

	it("never sends cookie or other uncapped headers", async () => {
		const { bodies, calls } = await recordAwaited(
			cfRequest(
				{},
				{
					cookie: header("Cookie", "session=SECRET_COOKIE"),
					"x-api-key": header("X-Api-Key", "SECRET_API_KEY"),
					authorization: header("Authorization", "Bearer SECRET_TOKEN"),
				},
			),
		);
		const raw = String(calls[0]?.init?.body);
		expect(raw).not.toContain("SECRET");
		expect(bodies[0].requests[0].headers).toEqual({
			"user-agent": GPTBOT_UA,
			authorization: "Bearer",
		});
	});

	it("applies omit to a CloudFront request", async () => {
		const { bodies } = await recordAwaited(cfRequest(), ok, {
			omit: ["userAgent", "matchKey"],
		});
		const record = bodies[0].requests[0];
		expect("userAgent" in record).toBe(false);
		expect("matchKey" in record).toBe(false);
		expect(record.headers).toEqual({});
		expect(record.platform).toBe("cloudfront");
	});

	it("reads the key from the env var for a CloudFront request too", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", KEY);
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		await relay.recordAgentVisit(cfRequest(), { apiUrl: API_URL });
		expect(ingestBodies(calls)).toHaveLength(1);
	});

	it("does not mutate the CloudFront request", async () => {
		const relay = await freshRelay();
		stubFetch({ [INGEST_URL]: ok });
		const request = cfRequest(
			{},
			{ "x-forwarded-for": header("X-Forwarded-For", "203.0.113.7") },
		);
		const snapshot = structuredClone(request);
		relay.isAgent(request);
		await relay.recordAgentVisit(request, { key: KEY, apiUrl: API_URL });
		expect(request).toEqual(snapshot);
	});
});

describe("CloudFront: multi-value headers", () => {
	it("keeps every value of a repeated header", async () => {
		const { bodies } = await recordAwaited(
			cfRequest(
				{},
				{
					accept: [
						{ key: "Accept", value: "text/html" },
						{ key: "Accept", value: "application/json" },
					],
				},
			),
		);
		const accept = bodies[0].requests[0].headers.accept;
		expect(accept).toContain("text/html");
		expect(accept).toContain("application/json");
	});

	it("finds an agent token in the second value of a repeated user-agent", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{},
					{
						"user-agent": [
							{ key: "User-Agent", value: CHROME_UA },
							{ key: "User-Agent", value: "GPTBot/1.2" },
						],
					},
				),
			),
		).toBe(true);
	});

	it("records the first host when the host header repeats", async () => {
		const { bodies } = await recordAwaited(
			cfRequest(
				{},
				{
					host: [
						{ key: "Host", value: "www.example.com" },
						{ key: "Host", value: "other.example.com" },
					],
				},
			),
		);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].requests[0].host).toBe("www.example.com");
	});

	it("accepts entries without the optional key field", async () => {
		const { bodies } = await recordAwaited({
			clientIp: PERSON_IP,
			method: "GET",
			uri: "/",
			querystring: "",
			headers: {
				host: [{ value: "www.example.com" }],
				"user-agent": [{ value: GPTBOT_UA }],
			},
		});
		expect(bodies[0].requests[0].userAgent).toBe(GPTBOT_UA);
	});
});

describe("CloudFront: isAgent", () => {
	it("detects an agent by user-agent", async () => {
		const relay = await freshRelay();
		const { fetchMock } = stubFetch({});
		expect(relay.isAgent(cfRequest())).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says no for a Chrome browser from a person's IP", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest({}, { "user-agent": header("User-Agent", CHROME_UA) }),
			),
		).toBe(false);
	});

	it("detects an agent by signature-agent", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{},
					{
						"user-agent": header("User-Agent", CHROME_UA),
						"signature-agent": header(
							"Signature-Agent",
							'"https://chatgpt.com"',
						),
					},
				),
			),
		).toBe(true);
	});

	it("detects an agent by a DPoP authorization", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{},
					{
						"user-agent": header("User-Agent", CHROME_UA),
						authorization: header("Authorization", "DPoP abc.def"),
					},
				),
			),
		).toBe(true);
	});

	it("detects an agent by clientIp in an OpenAI range", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{ clientIp: OPENAI_IP },
					{ "user-agent": header("User-Agent", CHROME_UA) },
				),
			),
		).toBe(true);
	});

	it("detects an agent by an IPv6 clientIp in uppercase", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{ clientIp: "2600:1F28:365:8000::1" },
					{ "user-agent": header("User-Agent", CHROME_UA) },
				),
			),
		).toBe(true);
	});

	it("ignores an OpenAI IP in a client-sent header when clientIp is a person", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{ clientIp: PERSON_IP },
					{
						"user-agent": header("User-Agent", CHROME_UA),
						"x-forwarded-for": header("X-Forwarded-For", OPENAI_IP),
						"cf-connecting-ip": header("CF-Connecting-IP", OPENAI_IP),
						"x-real-ip": header("X-Real-IP", OPENAI_IP),
					},
				),
			),
		).toBe(false);
	});

	it("says no for an empty clientIp and no agent header", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(
				cfRequest(
					{ clientIp: "" },
					{ "user-agent": header("User-Agent", CHROME_UA) },
				),
			),
		).toBe(false);
	});

	it("still detects the agent when a cookie holds characters outside Latin-1", async () => {
		const relay = await freshRelay();
		expect(
			relay.isAgent(cfRequest({}, { cookie: header("Cookie", "name=日本語") })),
		).toBe(true);
	});

	it.each([
		[
			"no headers",
			{ clientIp: PERSON_IP, method: "GET", uri: "/", querystring: "" },
		],
		[
			"null headers",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/",
				querystring: "",
				headers: null,
			},
		],
		[
			"a header that is not an array",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/",
				querystring: "",
				headers: { "user-agent": { value: "GPTBot" } },
			},
		],
		["no clientIp", { method: "GET", uri: "/", querystring: "", headers: {} }],
		["null input", null],
		["a number", 42],
	])("returns false without throwing for %s", async (_name, input) => {
		const relay = await freshRelay();
		expect(relay.isAgent(JSON.parse(JSON.stringify(input)))).toBe(false);
	});
});

describe("CloudFront: platform", () => {
	it("says cloudfront when a Vercel context and the Cloudflare userAgent are both present", async () => {
		Reflect.set(globalThis, REQUEST_CONTEXT, { get: () => ({}) });
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const { bodies } = await recordAwaited(cfRequest());
		expect(bodies[0].requests[0].platform).toBe("cloudfront");
	});

	it("keeps a Request on Vercel as vercel", async () => {
		Reflect.set(globalThis, REQUEST_CONTEXT, { get: () => ({}) });
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		await relay.recordAgentVisit(agentRequest(), { key: KEY, apiUrl: API_URL });
		expect(ingestBodies(calls)[0].requests[0].platform).toBe("vercel");
	});

	it("leaves platform out for a Request on plain Node", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		await relay.recordAgentVisit(agentRequest(), { key: KEY, apiUrl: API_URL });
		expect("platform" in ingestBodies(calls)[0].requests[0]).toBe(false);
	});

	it("takes the IP of a Request from its headers", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const request = agentRequest({ "x-forwarded-for": "203.0.113.7" });
		await relay.recordAgentVisit(request, { key: KEY, apiUrl: API_URL });
		expect(ingestBodies(calls)[0].requests[0].matchKey).toBe(
			matchKeyOf("203.0.113.7"),
		);
	});
});

describe("CloudFront: the post policy", () => {
	it("tries once and gives up at the CloudFront timeout, not the Request one", async () => {
		const relay = await freshRelay();
		relay.settings.cloudFrontTimeoutMs = 50;
		relay.settings.requestTimeoutMs = 5000;
		relay.settings.retryDelayMs = 1;
		const { calls } = stubFetch({ [INGEST_URL]: hang });
		const started = Date.now();
		await relay.recordAgentVisit(cfRequest(), { key: KEY, apiUrl: API_URL });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(calls).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("timeout");
	});

	it("keeps the Request timeout and the retry for a Request", async () => {
		const relay = await freshRelay();
		relay.settings.cloudFrontTimeoutMs = 5000;
		relay.settings.requestTimeoutMs = 50;
		relay.settings.retryDelayMs = 30;
		const { calls } = stubFetch({ [INGEST_URL]: hang });
		const started = Date.now();
		await relay.recordAgentVisit(agentRequest(), { key: KEY, apiUrl: API_URL });
		const elapsed = Date.now() - started;
		expect(calls).toHaveLength(2);
		expect(elapsed).toBeGreaterThanOrEqual(120);
		expect(elapsed).toBeLessThan(1000);
	});

	it("defaults to a 1 second timeout for CloudFront", async () => {
		const relay = await freshRelay();
		expect(relay.settings.cloudFrontTimeoutMs).toBe(1000);
		expect(relay.settings.requestTimeoutMs).toBe(2000);
		const { calls } = stubFetch({ [INGEST_URL]: hang });
		const started = Date.now();
		await relay.recordAgentVisit(cfRequest(), { key: KEY, apiUrl: API_URL });
		const elapsed = Date.now() - started;
		expect(calls).toHaveLength(1);
		expect(elapsed).toBeGreaterThanOrEqual(950);
		expect(elapsed).toBeLessThan(1500);
	});

	it("aborts the CloudFront fetch at 1000 ms under fake timers", async () => {
		vi.useFakeTimers();
		const relay = await freshRelay();
		let signal: AbortSignal | undefined;
		stubFetch({
			[INGEST_URL]: (url, init) => {
				signal = init?.signal ?? undefined;
				return hang(url, init);
			},
		});
		let settled = false;
		const result = relay
			.recordAgentVisit(cfRequest(), {
				key: KEY,
				apiUrl: API_URL,
				omit: ["matchKey"],
			})
			.then(() => {
				settled = true;
			});
		for (let tick = 0; tick < 50 && signal === undefined; tick++) {
			await Promise.resolve();
		}
		expect(signal).toBeDefined();
		await vi.advanceTimersByTimeAsync(999);
		expect(signal?.aborted).toBe(false);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		await result;
		expect(settled).toBe(true);
	});

	it.each([
		["a network error", networkError],
		["429", status(429)],
		["500", status(500)],
		["503", status(503)],
	])("does not retry a CloudFront post after %s", async (_name, failure) => {
		const relay = await freshRelay();
		relay.settings.retryDelayMs = 1;
		const { calls } = stubFetch({ [INGEST_URL]: failure });
		await relay.recordAgentVisit(cfRequest(), { key: KEY, apiUrl: API_URL });
		expect(calls).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("still retries a Request post after a 500", async () => {
		const relay = await freshRelay();
		relay.settings.retryDelayMs = 1;
		const { calls } = stubFetch({ [INGEST_URL]: status(500) });
		await relay.recordAgentVisit(agentRequest(), { key: KEY, apiUrl: API_URL });
		expect(calls).toHaveLength(2);
	});
});

describe("recordAgentVisit: the promise", () => {
	it("resolves only after the ingest has answered", async () => {
		const relay = await freshRelay();
		let answered = false;
		stubFetch({
			[INGEST_URL]: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				answered = true;
				return ok();
			},
		});
		const result = relay.recordAgentVisit(cfRequest(), {
			key: KEY,
			apiUrl: API_URL,
		});
		expect(result).toBeInstanceOf(Promise);
		await result;
		expect(answered).toBe(true);
	});

	it("resolves to undefined after the post of a Request too", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const value = await relay.recordAgentVisit(agentRequest(), {
			key: KEY,
			apiUrl: API_URL,
		});
		expect(value).toBeUndefined();
		expect(ingestBodies(calls)).toHaveLength(1);
	});

	it("returns a resolving promise when there is no key", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const result = relay.recordAgentVisit(cfRequest(), { apiUrl: API_URL });
		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("returns a resolving promise for an unknown region", async () => {
		const relay = await freshRelay();
		const result = relay.recordAgentVisit(
			cfRequest(),
			JSON.parse(`{"key":"${KEY}","region":"mars"}`),
		);
		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toBeUndefined();
	});

	it("returns a resolving promise for a malformed key", async () => {
		const relay = await freshRelay();
		await expect(
			relay.recordAgentVisit(cfRequest(), { key: "wwt_nope", apiUrl: API_URL }),
		).resolves.toBeUndefined();
	});

	it("resolves when fetch throws synchronously", async () => {
		const relay = await freshRelay();
		vi.stubGlobal("fetch", () => {
			throw new Error("sync failure");
		});
		await expect(
			relay.recordAgentVisit(cfRequest(), { key: KEY, apiUrl: API_URL }),
		).resolves.toBeUndefined();
	});

	it("resolves when the ingest answers 500", async () => {
		const { result, calls } = await recordAwaited(cfRequest(), status(500));
		await expect(result).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("resolves and still posts when waitUntil throws", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const result = relay.recordAgentVisit(cfRequest(), {
			key: KEY,
			apiUrl: API_URL,
			waitUntil: () => {
				throw new Error("boom");
			},
		});
		await expect(result).resolves.toBeUndefined();
		expect(ingestBodies(calls)).toHaveLength(1);
	});

	it("hands the same settled work to waitUntil and to the caller", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const background = collector();
		const result = relay.recordAgentVisit(agentRequest(), {
			key: KEY,
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		});
		await background.flush();
		await result;
		expect(ingestBodies(calls)).toHaveLength(1);
	});

	it("resolves when crypto.subtle fails, and posts without a match key", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		vi.stubGlobal("crypto", {
			randomUUID: () => "00000000-0000-4000-8000-000000000000",
			subtle: {
				importKey: () => Promise.reject(new Error("no subtle")),
				sign: () => Promise.reject(new Error("no subtle")),
			},
		});
		await expect(
			relay.recordAgentVisit(cfRequest(), { key: KEY, apiUrl: API_URL }),
		).resolves.toBeUndefined();
		const bodies = ingestBodies(calls);
		expect(bodies).toHaveLength(1);
		expect("matchKey" in bodies[0].requests[0]).toBe(false);
	});

	it.each([
		[
			"missing headers",
			{ clientIp: PERSON_IP, method: "GET", uri: "/pricing", querystring: "" },
		],
		[
			"null headers",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/pricing",
				querystring: "",
				headers: null,
			},
		],
		[
			"an empty clientIp",
			{
				clientIp: "",
				method: "GET",
				uri: "/pricing",
				querystring: "",
				headers: { host: [{ value: "www.example.com" }] },
			},
		],
		[
			"a header that is not an array",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/",
				querystring: "",
				headers: { host: { value: "www.example.com" } },
			},
		],
		[
			"an entry without a value",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/",
				querystring: "",
				headers: {
					host: [{ value: "www.example.com" }],
					"user-agent": [{ key: "User-Agent" }],
				},
			},
		],
		[
			"a header value with a newline",
			{
				clientIp: PERSON_IP,
				method: "GET",
				uri: "/",
				querystring: "",
				headers: {
					host: [{ value: "www.example.com" }],
					"user-agent": [{ value: "GPTBot\nx" }],
				},
			},
		],
		["null input", null],
		["a string", "https://example.com/"],
	])("resolves for malformed CloudFront input: %s", async (_name, input) => {
		const relay = await freshRelay();
		stubFetch({ [INGEST_URL]: ok });
		const result = relay.recordAgentVisit(JSON.parse(JSON.stringify(input)), {
			key: KEY,
			apiUrl: API_URL,
		});
		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toBeUndefined();
	});

	it("never records a path segment as the host when the host header is missing", async () => {
		const { bodies } = await recordAwaited({
			clientIp: PERSON_IP,
			method: "GET",
			uri: "/pricing",
			querystring: "x=1",
			headers: { "user-agent": [{ value: GPTBOT_UA }] },
		});
		expect(bodies).toHaveLength(0);
	});

	it("sends no entry value of undefined as the string undefined", async () => {
		const { bodies, calls } = await recordAwaited({
			clientIp: PERSON_IP,
			method: "GET",
			uri: "/",
			querystring: "",
			headers: {
				host: [{ value: "www.example.com" }],
				"user-agent": [{ value: GPTBOT_UA }],
				referer: [{ key: "Referer" }],
			},
		});
		expect(bodies).toHaveLength(1);
		expect(String(calls[0]?.init?.body)).not.toContain('"undefined"');
	});
});
