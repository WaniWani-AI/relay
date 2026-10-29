import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import type { RelayOptions } from "../src/index";
import {
	API_URL,
	agentRequest,
	collector,
	freshRelay,
	INGEST_URL,
	ingestBodies,
	KEY,
	ORG_KEY,
	stubFetch,
} from "./helpers";

const ok = () => new Response(null, { status: 202 });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", KEY);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function recordOne(
	request: Request,
	options: Record<string, unknown> = {},
) {
	const relay = await freshRelay();
	const { calls } = stubFetch({ [INGEST_URL]: ok });
	const background = collector();
	relay.recordAgentVisit(request, {
		apiUrl: API_URL,
		waitUntil: background.waitUntil,
		...options,
	});
	await background.flush();
	return { calls, bodies: ingestBodies(calls), relay };
}

describe("recordAgentVisit: the event", () => {
	it("posts one record with the contract fields", async () => {
		const before = Date.now();
		const { bodies, calls } = await recordOne(
			agentRequest({
				referer: "https://claude.ai/",
				accept: "text/html",
				"accept-language": "en-US",
				"x-forwarded-for": "203.0.113.7, 10.0.0.1",
			}),
		);
		const post = calls.find((call) => call.url === INGEST_URL);
		expect(post?.init?.method).toBe("POST");
		expect(new Headers(post?.init?.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(bodies).toHaveLength(1);
		const { requests } = bodies[0];
		expect(requests).toHaveLength(1);
		const record = requests[0];
		expect(Object.keys(record).sort()).toEqual(
			[
				"occurredAt",
				"method",
				"host",
				"path",
				"userAgent",
				"referer",
				"headers",
				"matchKey",
				"sourceEventId",
				"relayVersion",
			].sort(),
		);
		expect(record.method).toBe("GET");
		expect(record.host).toBe("www.example.com");
		expect(record.path).toBe("/pricing?x=1");
		expect(record.userAgent).toBe("Claude-User/1.0 (+https://anthropic.com)");
		expect(record.referer).toBe("https://claude.ai/");
		expect(record.occurredAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
		expect(Date.parse(record.occurredAt)).toBeGreaterThanOrEqual(before - 1);
		expect(record.sourceEventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(record.relayVersion).toBe(packageJson.version);
		expect(record.headers).toEqual({
			"user-agent": "Claude-User/1.0 (+https://anthropic.com)",
			referer: "https://claude.ai/",
			accept: "text/html",
			"accept-language": "en-US",
		});
	});

	it("derives the match key as HMAC-SHA256(orgKey, ip) and never sends the IP", async () => {
		const ip = "2001:DB8::42";
		const { bodies, calls } = await recordOne(
			agentRequest({ "x-forwarded-for": ` ${ip} , 10.0.0.1` }),
		);
		const expected = createHmac("sha256", ORG_KEY)
			.update("2001:db8::42")
			.digest("hex");
		expect(bodies[0].requests[0].matchKey).toBe(expected);
		expect(expected).toMatch(/^[0-9a-f]{64}$/);
		const raw = String(
			calls.find((call) => call.url === INGEST_URL)?.init?.body,
		);
		expect(raw.toLowerCase()).not.toContain("2001:db8::42");
		expect(raw).not.toContain("10.0.0.1");
	});

	it("matches a fixed known-answer vector", async () => {
		const { bodies } = await recordOne(
			agentRequest({ "x-real-ip": "198.51.100.23" }),
		);
		expect(
			createHmac("sha256", "b3JnLWtleS1zZWNyZXQ")
				.update("198.51.100.23")
				.digest("hex"),
		).toBe(bodies[0].requests[0].matchKey);
	});

	it("falls back to x-real-ip and omits the match key when there is no IP", async () => {
		const withRealIp = await recordOne(
			agentRequest({ "x-real-ip": "198.51.100.23" }),
		);
		expect(withRealIp.bodies[0].requests[0].matchKey).toMatch(/^[0-9a-f]{64}$/);
		const withoutIp = await recordOne(agentRequest());
		expect("matchKey" in withoutIp.bodies[0].requests[0]).toBe(false);
	});

	it("prefers cf-connecting-ip over a client-sent x-forwarded-for", async () => {
		const { bodies } = await recordOne(
			agentRequest({
				"cf-connecting-ip": "198.51.100.23",
				"x-forwarded-for": "20.171.206.9, 198.51.100.23",
			}),
		);
		expect(bodies[0].requests[0].matchKey).toBe(
			createHmac("sha256", ORG_KEY).update("198.51.100.23").digest("hex"),
		);
	});

	it("omits absent fields instead of sending nulls", async () => {
		const { calls } = await recordOne(new Request("https://example.com/"));
		const raw = String(
			calls.find((call) => call.url === INGEST_URL)?.init?.body,
		);
		expect(raw).not.toContain("null");
		const record = JSON.parse(raw).requests[0];
		expect(record.path).toBe("/");
		expect("userAgent" in record).toBe(false);
		expect("referer" in record).toBe(false);
		expect(record.headers).toEqual({});
	});

	it("gives every request its own sourceEventId", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const background = collector();
		relay.recordAgentVisit(agentRequest(), {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		});
		relay.recordAgentVisit(agentRequest(), {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		});
		await background.flush();
		const ids = ingestBodies(calls).map(
			(body) => body.requests[0].sourceEventId,
		);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("strips trailing slashes from apiUrl and defaults to app.waniwani.ai", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		const background = collector();
		relay.recordAgentVisit(agentRequest(), {
			apiUrl: `${API_URL}///`,
			waitUntil: background.waitUntil,
		});
		relay.recordAgentVisit(agentRequest(), {
			waitUntil: background.waitUntil,
		});
		relay.settings.retryDelayMs = 1;
		await background.flush();
		const urls = [...new Set(calls.map((call) => call.url))];
		expect(urls).toEqual([
			INGEST_URL,
			"https://app.waniwani.ai/api/v2/agent-traffic/ingest/middleware/tok-EN_123",
		]);
	});
});

describe("recordAgentVisit: the region", () => {
	const hostsFor = async (options: Array<RelayOptions>) => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		const background = collector();
		for (const option of options) {
			relay.recordAgentVisit(agentRequest(), {
				...option,
				waitUntil: background.waitUntil,
			});
		}
		relay.settings.retryDelayMs = 1;
		await background.flush();
		return [...new Set(calls.map((call) => new URL(call.url).origin))];
	};

	it("posts to the US host without a region", async () => {
		expect(await hostsFor([{}])).toEqual(["https://app.waniwani.ai"]);
	});

	it("posts to the host of each region", async () => {
		expect(await hostsFor([{ region: "us" }, { region: "eu" }])).toEqual([
			"https://app.waniwani.ai",
			"https://eu.app.waniwani.ai",
		]);
	});

	it("lets apiUrl win over the region", async () => {
		expect(
			await hostsFor([{ region: "eu", apiUrl: "https://dev.example.test/" }]),
		).toEqual(["https://dev.example.test"]);
	});

	it("sends nothing for an unknown region and warns once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const unknown = JSON.parse('{"region":"mars"}');
		const inherited = JSON.parse('{"region":"toString"}');
		expect(await hostsFor([unknown, unknown, inherited])).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain('"mars"');
	});
});

describe("recordAgentVisit: the header cap", () => {
	it("sends only capped headers and never reads cookie", async () => {
		const request = agentRequest({
			cookie: "session=SECRET_COOKIE",
			"x-api-key": "SECRET_API_KEY",
			"x-forwarded-for": "203.0.113.7",
			from: "bot@example.com",
			"signature-agent": '"https://chatgpt.com"',
			"signature-input": 'sig1=("@authority");created=1',
			signature: "sig1=:abc:",
			dpop: "eyJ.dpop.proof",
			"sec-ch-ua": '"Chromium";v="130"',
			"sec-ch-ua-platform": '"macOS"',
			"sec-ch-ua-mobile": "?0",
			host: "www.example.com",
		});
		const get = vi.spyOn(request.headers, "get");
		const { bodies, calls } = await recordOne(request);
		expect(get.mock.calls.map(([name]) => name.toLowerCase())).not.toContain(
			"cookie",
		);
		const raw = String(
			calls.find((call) => call.url === INGEST_URL)?.init?.body,
		);
		expect(raw).not.toContain("SECRET_COOKIE");
		expect(raw).not.toContain("SECRET_API_KEY");
		expect(Object.keys(bodies[0].requests[0].headers).sort()).toEqual(
			[
				"user-agent",
				"from",
				"signature-agent",
				"signature-input",
				"signature",
				"dpop",
				"sec-ch-ua",
				"sec-ch-ua-platform",
				"sec-ch-ua-mobile",
			].sort(),
		);
	});

	it.each([
		["DPoP eyJhbGciOiJFUzI1NiJ9.payload.sig", "DPoP"],
		["Bearer SECRET_TOKEN_VALUE", "Bearer"],
		["Basic dXNlcjpwYXNz", "Basic"],
		["  bearer   SECRET_TOKEN_VALUE  ", "Bearer"],
		["dpop SECRET_TOKEN_VALUE", "DPoP"],
		["dpop abc", "DPoP"],
		["NTLM SECRET_TOKEN_VALUE", "NTLM"],
		["scram-sha-256 SECRET_TOKEN_VALUE", "SCRAM-SHA-256"],
		["aws4-hmac-sha256 Credential=SECRET_TOKEN_VALUE", "AWS4-HMAC-SHA256"],
		["VAPID t=SECRET_TOKEN_VALUE", "vapid"],
		["privatetoken token=SECRET_TOKEN_VALUE", "PrivateToken"],
	])(
		"keeps only the canonical scheme of authorization %s",
		async (value, scheme) => {
			const { bodies, calls } = await recordOne(
				agentRequest({ authorization: value }),
			);
			expect(bodies[0].requests[0].headers.authorization).toBe(scheme);
			const raw = String(
				calls.find((call) => call.url === INGEST_URL)?.init?.body,
			);
			expect(raw).not.toContain("SECRET_TOKEN_VALUE");
			expect(raw).not.toContain("dXNlcjpwYXNz");
			expect(raw).not.toContain("payload.sig");
		},
	);

	it.each([
		"SECRET_TOKEN_WITHOUT_SCHEME",
		"Bearer",
		"{bad} SECRET",
		"",
		"sk_live_SECRET trailing",
		"sk_live_x trailing",
		"Token abc",
		"Token SECRET",
		"ApiKey SECRET",
		"Bearerx SECRET",
		"SECRET_live_key SECRET",
	])(
		"drops an authorization value without a known scheme and a credential: %s",
		async (value) => {
			const { bodies, calls } = await recordOne(
				agentRequest({ authorization: value }),
			);
			expect("authorization" in bodies[0].requests[0].headers).toBe(false);
			expect(
				String(calls.find((call) => call.url === INGEST_URL)?.init?.body),
			).not.toContain("SECRET");
		},
	);
});

describe("recordAgentVisit: omit", () => {
	it("removes named headers and the match key", async () => {
		const { bodies } = await recordOne(
			agentRequest({
				"accept-language": "de",
				accept: "text/html",
				"x-forwarded-for": "203.0.113.7",
			}),
			{ omit: ["Accept-Language", "matchKey"] },
		);
		const record = bodies[0].requests[0];
		expect(record.headers).toEqual({
			"user-agent": "Claude-User/1.0 (+https://anthropic.com)",
			accept: "text/html",
		});
		expect("matchKey" in record).toBe(false);
	});

	it("removes userAgent and referer as fields and as headers", async () => {
		const { bodies } = await recordOne(
			agentRequest({ referer: "https://claude.ai/" }),
			{
				omit: ["userAgent", "referer"],
			},
		);
		const record = bodies[0].requests[0];
		expect("userAgent" in record).toBe(false);
		expect("referer" in record).toBe(false);
		expect(record.headers).toEqual({});
	});

	it("treats user-agent and userAgent the same way", async () => {
		const { bodies } = await recordOne(agentRequest(), {
			omit: ["user-agent"],
		});
		expect("userAgent" in bodies[0].requests[0]).toBe(false);
		expect(bodies[0].requests[0].headers).toEqual({});
	});

	it("still records the visit when the header that matched is omitted", async () => {
		const { bodies } = await recordOne(
			agentRequest({ "signature-agent": '"https://chatgpt.com"' }),
			{
				omit: [
					"signature-agent",
					"signature",
					"signature-input",
					"authorization",
				],
			},
		);
		expect(bodies).toHaveLength(1);
		expect("signature-agent" in bodies[0].requests[0].headers).toBe(false);
	});
});

describe("recordAgentVisit: the key", () => {
	it("sends nothing and warns nothing without a key", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", undefined);
		const { calls } = await recordOne(agentRequest());
		expect(calls).toHaveLength(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("sends nothing for an empty key", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "  ");
		const { calls } = await recordOne(agentRequest());
		expect(calls).toHaveLength(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		"wwt_onlytoken",
		"wwk_tok.org",
		"wwt_.org",
		"wwt_tok.",
		"wwt_to.k.org",
		"wwt_tok/en.org",
		"tok.org",
	])(
		"sends nothing for the malformed key %s and warns once per instance",
		async (key) => {
			const relay = await freshRelay();
			const { calls } = stubFetch({ [INGEST_URL]: ok });
			const background = collector();
			relay.recordAgentVisit(agentRequest(), {
				key,
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
			});
			relay.recordAgentVisit(agentRequest(), {
				key,
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
			});
			await background.flush();
			expect(calls).toHaveLength(0);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).not.toContain(key);
		},
	);

	it("prefers options.key over the env var and trims whitespace", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "garbage");
		const { calls } = await recordOne(agentRequest(), { key: `  ${KEY}\n` });
		expect(calls.map((call) => call.url)).toContain(INGEST_URL);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("recordAgentVisit: waitUntil", () => {
	it("hands a promise that resolves to options.waitUntil even when the post fails", async () => {
		const relay = await freshRelay();
		relay.settings.retryDelayMs = 1;
		stubFetch({});
		const promises: Promise<unknown>[] = [];
		relay.recordAgentVisit(agentRequest(), {
			apiUrl: API_URL,
			waitUntil: (p) => promises.push(p),
		});
		expect(promises.length).toBeGreaterThan(0);
		await expect(Promise.all(promises)).resolves.toBeDefined();
	});

	it("never throws when waitUntil throws", async () => {
		const relay = await freshRelay();
		stubFetch({ [INGEST_URL]: ok });
		expect(() =>
			relay.recordAgentVisit(agentRequest(), {
				apiUrl: API_URL,
				waitUntil: () => {
					throw new Error("boom");
				},
			}),
		).not.toThrow();
	});

	it("uses the waitUntil of the Vercel request context by default", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const promises: Promise<unknown>[] = [];
		const context = {
			waitUntil(this: unknown, p: Promise<unknown>) {
				expect(this).toBe(context);
				promises.push(p);
			},
		};
		vi.stubGlobal(Symbol.for("@vercel/request-context"), {
			get: () => context,
		});
		relay.recordAgentVisit(agentRequest(), { apiUrl: API_URL });
		expect(promises).toHaveLength(1);
		await Promise.all(promises);
		expect(ingestBodies(calls)).toHaveLength(1);
	});

	it("still posts when there is no request context and no waitUntil", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		relay.recordAgentVisit(agentRequest(), { apiUrl: API_URL });
		await vi.waitFor(() => expect(ingestBodies(calls)).toHaveLength(1));
	});

	it("still posts when the request context has no waitUntil", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		vi.stubGlobal(Symbol.for("@vercel/request-context"), { get: () => ({}) });
		relay.recordAgentVisit(agentRequest(), { apiUrl: API_URL });
		await vi.waitFor(() => expect(ingestBodies(calls)).toHaveLength(1));
	});

	it("never touches the request body", async () => {
		const request = new Request("https://www.example.com/form", {
			method: "POST",
			body: "a=1",
			headers: { "user-agent": "Claude-User/1.0" },
		});
		const { bodies } = await recordOne(request);
		expect(bodies[0].requests[0].method).toBe("POST");
		expect(request.bodyUsed).toBe(false);
		expect(await request.text()).toBe("a=1");
	});
});

describe("isAgent", () => {
	it("decides from headers only and never calls fetch", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		expect(relay.isAgent(agentRequest())).toBe(true);
		expect(
			relay.isAgent(
				new Request("https://example.com/", {
					headers: { "user-agent": "curl/8.7.1" },
				}),
			),
		).toBe(false);
		expect(
			relay.isAgent(
				new Request("https://example.com/", {
					headers: { "user-agent": "Mozilla/5.0", "signature-agent": '"x"' },
				}),
			),
		).toBe(true);
		expect(
			relay.isAgent(
				new Request("https://example.com/", {
					headers: { authorization: "DPoP abc.def.ghi" },
				}),
			),
		).toBe(true);
		expect(
			relay.isAgent(
				new Request("https://example.com/", {
					headers: { "x-forwarded-for": "20.171.206.9" },
				}),
			),
		).toBe(true);
		expect(
			relay.isAgent(
				new Request("https://example.com/", {
					headers: {
						"cf-connecting-ip": "198.51.100.23",
						"x-forwarded-for": "20.171.206.9, 198.51.100.23",
					},
				}),
			),
		).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("never reads cookie", async () => {
		const relay = await freshRelay();
		const request = agentRequest({ cookie: "a=b" });
		const get = vi.spyOn(request.headers, "get");
		relay.isAgent(request);
		expect(get.mock.calls.map(([name]) => name.toLowerCase())).not.toContain(
			"cookie",
		);
	});
});

describe("isAgent: authorization", () => {
	it.each([
		["dpop abc.def", true],
		["DPoP abc.def", true],
		["DPoP", false],
		["Token abc", false],
		["sk_live_x trailing", false],
	])("treats authorization %s as agent: %s", async (value, expected) => {
		const relay = await freshRelay();
		const request = new Request("https://example.com/", {
			headers: { "user-agent": "Mozilla/5.0 Chrome/130", authorization: value },
		});
		expect(relay.isAgent(request)).toBe(expected);
	});
});
