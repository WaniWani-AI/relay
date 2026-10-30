import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IsAgentOptions } from "../src/index";
import {
	API_URL,
	collector,
	freshRelay,
	type Handler,
	hang,
	INGEST_URL,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/rules`;
const CANARY = "zqcanarybot";
const SECOND = "zqsecondbot";
const GPTBOT_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const BUNDLED_IP = "20.171.206.9";
const PERSON_IP = "198.51.100.23";
const T0 = new Date("2026-10-30T00:00:00.000Z").getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

const ua = (userAgent: string) =>
	new Request("https://example.com/", {
		headers: { "user-agent": userAgent },
	});

const fromIp = (ip: string) =>
	new Request("https://example.com/", {
		headers: { "user-agent": "curl/8.7.1", "x-forwarded-for": ip },
	});

const canaryRequest = () => ua(`${CANARY}/1.0`);

type RangeEntry = {
	source?: unknown;
	bot?: unknown;
	ipv4?: unknown;
	ipv6?: unknown;
};

function rulesFile(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		hash: "abc123",
		generatedAt: "2026-10-30T00:00:00.000Z",
		tokens: [CANARY],
		bots: [],
		ipRanges: [
			{
				source: "test",
				bot: "TestBot",
				ipv4: ["192.0.2.0/24"],
				ipv6: ["2001:db8::/32"],
			},
		],
		...overrides,
	};
}

const withRange = (range: RangeEntry) =>
	rulesFile({
		ipRanges: [
			{ source: "test", bot: "TestBot", ipv4: [], ipv6: [], ...range },
		],
	});

const bareJson =
	(body: unknown, status = 200): Handler =>
	() =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

const envelope = (data: unknown) => ({
	success: true,
	message: "success",
	data,
});

const json = (data: unknown, status = 200): Handler =>
	bareJson(envelope(data), status);

const raw =
	(body: string | null, status = 200): Handler =>
	() =>
		new Response(body, { status });

const rulesCalls = (calls: Array<{ url: string }>) =>
	calls.filter((call) => call.url === RULES_URL);

async function load(handler: Handler) {
	const relay = await freshRelay();
	const { calls, fetchMock } = stubFetch({ [RULES_URL]: handler });
	const background = collector();
	const options: IsAgentOptions = {
		apiUrl: API_URL,
		waitUntil: background.waitUntil,
	};
	const check = (request: Request) => relay.isAgent(request, options);
	check(ua("curl/8.7.1"));
	await background.flush();
	return { relay, calls, fetchMock, background, options, check };
}

async function swappedBy(handler: Handler) {
	const { check } = await load(handler);
	return check(canaryRequest());
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
});

describe("rules refresh: the fetch", () => {
	it("the bundled rules do not know the canary token, the test IPs or curl", async () => {
		const relay = await freshRelay();
		stubFetch({});
		const bundled = { rules: "bundled" } as const;
		expect(relay.isAgent(canaryRequest(), bundled)).toBe(false);
		expect(relay.isAgent(ua(`${SECOND}/1.0`), bundled)).toBe(false);
		expect(relay.isAgent(fromIp("192.0.2.5"), bundled)).toBe(false);
		expect(relay.isAgent(fromIp("2001:db8::5"), bundled)).toBe(false);
		expect(relay.isAgent(fromIp(PERSON_IP), bundled)).toBe(false);
		expect(relay.isAgent(ua(GPTBOT_UA), bundled)).toBe(true);
		expect(relay.isAgent(fromIp(BUNDLED_IP), bundled)).toBe(true);
	});

	it("the first call starts exactly one GET of {apiUrl}/api/v2/agent-traffic/rules", async () => {
		const { calls } = await load(json(rulesFile()));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(RULES_URL);
		const method = calls[0]?.init?.method;
		expect(method === undefined || method.toUpperCase() === "GET").toBe(true);
		expect(calls[0]?.init?.body ?? null).toBeNull();
	});

	it("fetches from the us host by default", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		const background = collector();
		relay.isAgent(ua("curl/8.7.1"), { waitUntil: background.waitUntil });
		await background.flush();
		expect(calls.map((call) => call.url)).toEqual([
			"https://app.waniwani.ai/api/v2/agent-traffic/rules",
		]);
	});

	it("fetches from the eu host for region eu", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		const background = collector();
		relay.isAgent(ua("curl/8.7.1"), {
			region: "eu",
			waitUntil: background.waitUntil,
		});
		await background.flush();
		expect(calls.map((call) => call.url)).toEqual([
			"https://eu.app.waniwani.ai/api/v2/agent-traffic/rules",
		]);
	});

	it("stays synchronous: returns a boolean while the fetch is still open, and decides by the old rules", async () => {
		const relay = await freshRelay();
		let answer: (response: Response) => void = () => {};
		const { calls } = stubFetch({
			[RULES_URL]: () =>
				new Promise<Response>((resolve) => {
					answer = resolve;
				}),
		});
		const background = collector();
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		};

		const first = relay.isAgent(canaryRequest(), options);
		expect(first).toBe(false);
		expect(rulesCalls(calls)).toHaveLength(1);

		expect(relay.isAgent(canaryRequest(), options)).toBe(false);
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
		expect(relay.isAgent(fromIp(BUNDLED_IP), options)).toBe(true);
		expect(rulesCalls(calls)).toHaveLength(1);

		answer(
			new Response(JSON.stringify(envelope(rulesFile())), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await background.flush();

		expect(relay.isAgent(canaryRequest(), options)).toBe(true);
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(false);
		expect(rulesCalls(calls)).toHaveLength(1);
	});

	it("many calls in one window start one fetch", async () => {
		const { calls, check } = await load(json(rulesFile()));
		for (let i = 0; i < 50; i++) {
			check(ua("curl/8.7.1"));
		}
		expect(rulesCalls(calls)).toHaveLength(1);
	});

	it("hands the work to options.waitUntil, and the swap is done once that promise settles", async () => {
		const relay = await freshRelay();
		stubFetch({ [RULES_URL]: json(rulesFile()) });
		const waitUntil = vi.fn((_promise: Promise<unknown>) => {});
		relay.isAgent(ua("curl/8.7.1"), { apiUrl: API_URL, waitUntil });
		expect(waitUntil).toHaveBeenCalledTimes(1);
		const work = waitUntil.mock.calls[0]?.[0];
		expect(work).toBeInstanceOf(Promise);
		await work;
		expect(relay.isAgent(canaryRequest(), { apiUrl: API_URL, waitUntil })).toBe(
			true,
		);
	});

	it("hands the work to the Vercel request-context waitUntil when no waitUntil is passed", async () => {
		const pending: Promise<unknown>[] = [];
		Reflect.set(globalThis, REQUEST_CONTEXT, {
			get: () => ({
				waitUntil: (promise: Promise<unknown>) => {
					pending.push(promise);
				},
			}),
		});
		const relay = await freshRelay();
		const { calls } = stubFetch({ [RULES_URL]: json(rulesFile()) });
		relay.isAgent(ua("curl/8.7.1"), { apiUrl: API_URL });
		expect(rulesCalls(calls)).toHaveLength(1);
		expect(pending).toHaveLength(1);
		await Promise.all(pending);
		expect(relay.isAgent(canaryRequest(), { apiUrl: API_URL })).toBe(true);
	});

	it("a waitUntil that throws does not make isAgent throw", async () => {
		const relay = await freshRelay();
		stubFetch({ [RULES_URL]: json(rulesFile()) });
		expect(
			relay.isAgent(ua(GPTBOT_UA), {
				apiUrl: API_URL,
				waitUntil: () => {
					throw new Error("boom");
				},
			}),
		).toBe(true);
	});

	it("never throws when fetch throws synchronously", async () => {
		const relay = await freshRelay();
		vi.stubGlobal("fetch", () => {
			throw new Error("sync boom");
		});
		const background = collector();
		expect(
			relay.isAgent(ua(GPTBOT_UA), {
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
			}),
		).toBe(true);
		await background.flush();
		expect(
			relay.isAgent(ua(GPTBOT_UA), {
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
			}),
		).toBe(true);
	});

	it("never throws when there is no global fetch", async () => {
		const relay = await freshRelay();
		vi.stubGlobal("fetch", undefined);
		const background = collector();
		expect(
			relay.isAgent(ua(GPTBOT_UA), {
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
			}),
		).toBe(true);
		await background.flush();
	});

	it("an unknown region makes no fetch and does not throw", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({});
		const options = JSON.parse('{"region":"mars"}');
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
		expect(calls).toHaveLength(0);
	});
});

describe("rules refresh: bundled mode", () => {
	it("makes no fetch, ever, and keeps the bundled list", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const relay = await freshRelay();
		const { calls } = stubFetch({ [RULES_URL]: json(rulesFile()) });
		const background = collector();
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
			rules: "bundled",
		};
		for (const elapsed of [0, 5 * MINUTE, 12 * HOUR, 25 * HOUR]) {
			vi.setSystemTime(T0 + elapsed);
			expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
			expect(relay.isAgent(canaryRequest(), options)).toBe(false);
			await background.flush();
		}
		expect(calls).toHaveLength(0);
	});
});

describe("rules refresh: bundled mode after remote rules loaded", () => {
	const bundled = { rules: "bundled" } as const;

	it("bundled calls decide by the bundled lists only, default calls keep the remote rules", async () => {
		const { relay, check } = await load(json(rulesFile()));
		expect(check(canaryRequest())).toBe(true);

		expect(relay.isAgent(canaryRequest(), bundled)).toBe(false);
		expect(relay.isAgent(fromIp("192.0.2.5"), bundled)).toBe(false);
		expect(relay.isAgent(fromIp("2001:db8::5"), bundled)).toBe(false);
		expect(relay.isAgent(ua(GPTBOT_UA), bundled)).toBe(true);
		expect(relay.isAgent(fromIp(BUNDLED_IP), bundled)).toBe(true);

		expect(check(canaryRequest())).toBe(true);
		expect(check(fromIp("192.0.2.5"))).toBe(true);
		expect(check(ua(GPTBOT_UA))).toBe(false);
		expect(check(fromIp(BUNDLED_IP))).toBe(false);
	});

	it("bundled calls with apiUrl and waitUntil still use the bundled lists and start no fetch", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const { relay, calls, background, check } = await load(json(rulesFile()));
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
			rules: "bundled",
		};
		vi.setSystemTime(T0 + 13 * HOUR);
		expect(relay.isAgent(canaryRequest(), options)).toBe(false);
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
		await background.flush();
		expect(rulesCalls(calls)).toHaveLength(1);
		expect(check(canaryRequest())).toBe(true);
	});

	it("a bundled call during the open fetch and after it decides by the bundled lists", async () => {
		const relay = await freshRelay();
		let answer: (response: Response) => void = () => {};
		stubFetch({
			[RULES_URL]: () =>
				new Promise<Response>((resolve) => {
					answer = resolve;
				}),
		});
		const background = collector();
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		};
		relay.isAgent(ua("curl/8.7.1"), options);
		expect(relay.isAgent(ua(GPTBOT_UA), bundled)).toBe(true);
		answer(
			new Response(JSON.stringify(envelope(rulesFile())), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await background.flush();
		expect(relay.isAgent(ua(GPTBOT_UA), bundled)).toBe(true);
		expect(relay.isAgent(canaryRequest(), bundled)).toBe(false);
		expect(relay.isAgent(canaryRequest(), options)).toBe(true);
	});
});

describe("rules refresh: recordAgentVisit is unchanged", () => {
	it("posts the visit and fetches no rules", async () => {
		vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", KEY);
		const relay = await freshRelay();
		const { calls } = stubFetch({
			[INGEST_URL]: () => new Response(null, { status: 202 }),
			[RULES_URL]: json(rulesFile()),
		});
		const background = collector();
		await relay.recordAgentVisit(ua(GPTBOT_UA), {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		});
		await background.flush();
		expect(calls.map((call) => call.url)).toEqual([INGEST_URL]);
	});
});

describe("rules refresh: after a swap", () => {
	it("matches the new tokens and no longer the tokens only in the bundled list", async () => {
		const { check } = await load(json(rulesFile({ tokens: [CANARY, SECOND] })));
		expect(check(canaryRequest())).toBe(true);
		expect(
			check(ua(`Mozilla/5.0 (compatible; ${SECOND.toUpperCase()}/2)`)),
		).toBe(true);
		expect(check(ua(GPTBOT_UA))).toBe(false);
		expect(check(ua("Claude-User/1.0 (+https://anthropic.com)"))).toBe(false);
	});

	it("matches the new IPv4 and IPv6 ranges, and no longer the bundled ranges", async () => {
		const { check } = await load(json(rulesFile()));
		expect(check(fromIp("192.0.2.5"))).toBe(true);
		expect(check(fromIp("192.0.3.5"))).toBe(false);
		expect(check(fromIp("2001:db8::5"))).toBe(true);
		expect(check(fromIp("2001:db9::5"))).toBe(false);
		expect(check(fromIp(BUNDLED_IP))).toBe(false);
	});

	it("non-token signals still count after a swap", async () => {
		const { check } = await load(json(rulesFile()));
		expect(
			check(
				new Request("https://example.com/", {
					headers: { "user-agent": "Mozilla/5.0", "signature-agent": '"x"' },
				}),
			),
		).toBe(true);
	});

	it("accepts an empty ipRanges array and then matches no IP", async () => {
		const { check } = await load(json(rulesFile({ ipRanges: [] })));
		expect(check(canaryRequest())).toBe(true);
		expect(check(fromIp(BUNDLED_IP))).toBe(false);
	});
});

describe("rules refresh: failures keep the current rules", () => {
	it.each([400, 404, 429, 500, 502, 503])(
		"keeps the bundled rules on HTTP %i with a valid body",
		async (status) => {
			const { check } = await load(json(rulesFile(), status));
			expect(check(canaryRequest())).toBe(false);
			expect(check(ua(GPTBOT_UA))).toBe(true);
		},
	);

	it("keeps the bundled rules on a network error", async () => {
		const { check, calls } = await load(() => {
			throw new TypeError("fetch failed");
		});
		expect(rulesCalls(calls)).toHaveLength(1);
		expect(check(canaryRequest())).toBe(false);
		expect(check(ua(GPTBOT_UA))).toBe(true);
	});

	it("gives up after the 2 s timeout and keeps the bundled rules", async () => {
		const relay = await freshRelay();
		const { calls } = stubFetch({ [RULES_URL]: hang });
		const background = collector();
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		};
		const started = Date.now();
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
		expect(Date.now() - started).toBeLessThan(500);
		await background.flush();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(1900);
		expect(elapsed).toBeLessThan(4000);
		expect(rulesCalls(calls)).toHaveLength(1);
		expect(relay.isAgent(canaryRequest(), options)).toBe(false);
		expect(relay.isAgent(ua(GPTBOT_UA), options)).toBe(true);
	});

	it.each<[string, Handler]>([
		["a body that is not JSON", raw("<html>oops</html>")],
		["an empty 200 body", raw("")],
		["a 204 with no body", raw(null, 204)],
		["data null", json(null)],
		["data as a string", json("tokens")],
		["data as a JSON string of the file", json(JSON.stringify(rulesFile()))],
		["data as a number", json(1)],
		["data as an array", json([rulesFile()])],
		["data as true", json(true)],
		[
			"an envelope without data",
			bareJson({ success: true, message: "success" }),
		],
		["the bare rules file", bareJson(rulesFile())],
		[
			"the bare rules file with success fields",
			bareJson({ ...rulesFile(), success: true, message: "success" }),
		],
		["a JSON null body", bareJson(null)],
		["a JSON string body", bareJson("tokens")],
		["a JSON array body", bareJson([envelope(rulesFile())])],
		["data nested one level too deep", json(envelope(rulesFile()))],
		["a missing version", json({ ...rulesFile(), version: undefined })],
		["version 2", json(rulesFile({ version: 2 }))],
		["version 0", json(rulesFile({ version: 0 }))],
		['version "1"', json(rulesFile({ version: "1" }))],
		["missing tokens", json({ ...rulesFile(), tokens: undefined })],
		["tokens as a string", json(rulesFile({ tokens: CANARY }))],
		["tokens as an object", json(rulesFile({ tokens: { 0: CANARY } }))],
		["an empty tokens array", json(rulesFile({ tokens: [] }))],
		["a number among tokens", json(rulesFile({ tokens: [CANARY, 12345] }))],
		["a null among tokens", json(rulesFile({ tokens: [CANARY, null] }))],
		["missing ipRanges", json({ ...rulesFile(), ipRanges: undefined })],
		["ipRanges as an object", json(rulesFile({ ipRanges: {} }))],
		["ipRanges as null", json(rulesFile({ ipRanges: null }))],
		["a null ipRanges entry", json(rulesFile({ ipRanges: [null] }))],
		[
			"a string ipRanges entry",
			json(rulesFile({ ipRanges: ["192.0.2.0/24"] })),
		],
		["ipv4 as a string", json(withRange({ ipv4: "192.0.2.0/24" }))],
		["ipv6 as a string", json(withRange({ ipv6: "2001:db8::/32" }))],
		["a number among ipv4", json(withRange({ ipv4: ["192.0.2.0/24", 7] }))],
	])("keeps the bundled rules for %s", async (_name, handler) => {
		const { check } = await load(handler);
		expect(check(canaryRequest())).toBe(false);
		expect(check(ua(GPTBOT_UA))).toBe(true);
		expect(check(fromIp(BUNDLED_IP))).toBe(true);
	});
});

describe("rules refresh: token checks", () => {
	it("accepts a 4-character token and matches it", async () => {
		const { check } = await load(json(rulesFile({ tokens: [CANARY, "zqxv"] })));
		expect(check(canaryRequest())).toBe(true);
		expect(check(ua("zqxv/1.0"))).toBe(true);
	});

	it("refuses the whole file for a 3-character token", async () => {
		expect(await swappedBy(json(rulesFile({ tokens: [CANARY, "zqx"] })))).toBe(
			false,
		);
	});

	it("refuses the whole file for an empty-string token", async () => {
		expect(await swappedBy(json(rulesFile({ tokens: [CANARY, ""] })))).toBe(
			false,
		);
	});

	it("accepts a 128-character token", async () => {
		const long = `zq${"a".repeat(126)}`;
		expect(long).toHaveLength(128);
		const { check } = await load(json(rulesFile({ tokens: [CANARY, long] })));
		expect(check(canaryRequest())).toBe(true);
		expect(check(ua(`${long}/1.0`))).toBe(true);
	});

	it("refuses a 129-character token", async () => {
		const long = `zq${"a".repeat(127)}`;
		expect(long).toHaveLength(129);
		expect(await swappedBy(json(rulesFile({ tokens: [CANARY, long] })))).toBe(
			false,
		);
	});

	it.each(["ZQCANARYBOT", "ZqBot", "zqBot"])(
		"refuses a token with uppercase letters (%s)",
		async (token) => {
			expect(
				await swappedBy(json(rulesFile({ tokens: [CANARY, token] }))),
			).toBe(false);
		},
	);

	it("accepts exactly 5000 tokens", async () => {
		const tokens = Array.from({ length: 4999 }, (_, i) => `zqtok${i}x`);
		tokens.push(CANARY);
		expect(tokens).toHaveLength(5000);
		const { check } = await load(json(rulesFile({ tokens })));
		expect(check(canaryRequest())).toBe(true);
		expect(check(ua("zqtok4998x"))).toBe(true);
	});

	it("refuses 5001 tokens", async () => {
		const tokens = Array.from({ length: 5000 }, (_, i) => `zqtok${i}x`);
		tokens.push(CANARY);
		expect(tokens).toHaveLength(5001);
		expect(await swappedBy(json(rulesFile({ tokens })))).toBe(false);
	});
});

describe("rules refresh: token shape", () => {
	it.each(["abc1", "1abc", "9zqbot", "zq-bot.v2/x y_z", "zqbot x", "zqbot "])(
		"accepts %j and matches it",
		async (token) => {
			const { check } = await load(
				json(rulesFile({ tokens: [CANARY, token] })),
			);
			expect(check(canaryRequest())).toBe(true);
			expect(check(ua(`prefix ${token}suffix`))).toBe(true);
		},
	);

	it.each([
		"x11;",
		"x11 ",
		"a1b2",
		"ab1cd",
		"12345",
		"1.2.3/4",
		"(compatible",
		"-zqbot",
		" zqbot",
		".zqbot",
		"_zqbot",
		"/zqbot",
		"zqbot;",
		"zqbot)",
		"zq(bot",
		"zqbot+",
		"zqbot:1",
		"zqbot,x",
		"zqbot\t",
		"zqbot\n",
		"zqb\u00f3t",
		"zqbot*",
		'zqbot"',
	])("refuses the whole file for %j", async (token) => {
		expect(await swappedBy(json(rulesFile({ tokens: [CANARY, token] })))).toBe(
			false,
		);
	});
});

describe("rules refresh: browser-like tokens", () => {
	async function accepted(token: string) {
		const { check } = await load(json(rulesFile({ tokens: [CANARY, token] })));
		return {
			swapped: check(canaryRequest()),
			matches: check(ua(`Agent ${token} end`)),
		};
	}

	it.each([
		"chrome/14",
		"chrome/1234",
		"x11 linux",
		"linux x86_64",
		"samsungbrowser/2",
		"opr/115",
		"cros x",
		"ipad",
		"ozil",
		"safari/0 edg",
		"gecko/2010",
		"mobile safari",
		"mozilla/5.0",
		"chrome/",
		"edg/",
		"cpu iphone os 18",
	])(
		"accepts %j, which looks like browser text, and matches it",
		async (token) => {
			expect(await accepted(token)).toEqual({ swapped: true, matches: true });
		},
	);

	it.each([
		"claude-user",
		"chatgpt-user",
		"gptbot",
		"edge",
		"4everbot",
		"datenbank crawler",
		"kernel searchbot",
		"allenai.org",
		"cursor/1.0.0",
		"meta-externalagent",
	])("accepts the bot token %j and matches it", async (token) => {
		expect(await accepted(token)).toEqual({ swapped: true, matches: true });
	});

	it.each(["x11;", "x11; linux", "(compatible", "Mozilla"])(
		"still refuses %j, which fails the shape or lowercase rule",
		async (token) => {
			expect(
				await swappedBy(json(rulesFile({ tokens: [CANARY, token] }))),
			).toBe(false);
		},
	);

	it("a browser request stays a person after a valid swap", async () => {
		const { check } = await load(json(rulesFile()));
		for (const browser of [
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:133.0) Gecko/20100101 Firefox/133.0",
		]) {
			expect(check(ua(browser))).toBe(false);
		}
	});
});

describe("rules refresh: CIDR checks", () => {
	it.each([
		["IPv4 /16", { ipv4: ["10.20.0.0/16"] }, "10.20.200.1"],
		["IPv4 /17", { ipv4: ["10.20.0.0/17"] }, "10.20.100.1"],
		["IPv4 /31", { ipv4: ["192.0.2.76/31"] }, "192.0.2.77"],
		["IPv4 /32", { ipv4: ["192.0.2.77/32"] }, "192.0.2.77"],
		["IPv6 /32", { ipv6: ["2a0f:1::/32"] }, "2a0f:1:ffff::1"],
		["IPv6 /33", { ipv6: ["2a0f:1::/33"] }, "2a0f:1:10::1"],
		["IPv6 /127", { ipv6: ["2001:db8::76/127"] }, "2001:db8::77"],
		["IPv6 /128", { ipv6: ["2001:db8::77/128"] }, "2001:db8::77"],
	])("accepts %s and matches inside it", async (_name, range, ip) => {
		const { check } = await load(
			json(
				rulesFile({
					ipRanges: [{ source: "t", bot: "T", ipv4: [], ipv6: [], ...range }],
				}),
			),
		);
		expect(check(canaryRequest())).toBe(true);
		expect(check(fromIp(ip))).toBe(true);
	});

	it.each<[string, RangeEntry]>([
		["IPv4 /15", { ipv4: ["198.18.0.0/15"] }],
		["IPv4 /8", { ipv4: ["10.0.0.0/8"] }],
		["IPv4 /7", { ipv4: ["10.0.0.0/7"] }],
		["IPv4 /0", { ipv4: ["0.0.0.0/0"] }],
		["IPv4 /33", { ipv4: ["192.0.2.0/33"] }],
		["IPv6 /31", { ipv6: ["2a0e::/31"] }],
		["IPv6 /16", { ipv6: ["2a0f::/16"] }],
		["IPv6 /15", { ipv6: ["2a0e::/15"] }],
		["IPv6 /0", { ipv6: ["::/0"] }],
		["IPv6 /129", { ipv6: ["2001:db8::/129"] }],
		[
			"one /15 among valid IPv4 ranges",
			{ ipv4: ["192.0.2.0/24", "198.18.0.0/15"] },
		],
		[
			"one /31 among valid IPv6 ranges",
			{ ipv6: ["2001:db8::/32", "2a0e::/31"] },
		],
		["an IPv4 without prefix", { ipv4: ["192.0.2.0"] }],
		["an IPv4 with an empty prefix", { ipv4: ["192.0.2.0/"] }],
		["an IPv4 with a negative prefix", { ipv4: ["192.0.2.0/-8"] }],
		["an IPv4 with a fractional prefix", { ipv4: ["192.0.2.0/24.5"] }],
		["an IPv4 with two slashes", { ipv4: ["192.0.2.0/24/8"] }],
		["an IPv4 out of range", { ipv4: ["300.0.2.0/24"] }],
		["an empty IPv4 string", { ipv4: [""] }],
		["an IPv6 in the ipv4 list", { ipv4: ["2001:db8::/32"] }],
		["an IPv4 in the ipv6 list", { ipv6: ["192.0.2.0/24"] }],
		["an IPv6 without prefix", { ipv6: ["2001:db8::"] }],
		["a hostname", { ipv4: ["example.com/24"] }],
	])("refuses the whole file for %s", async (_name, range) => {
		const { check } = await load(json(withRange(range)));
		expect(check(canaryRequest())).toBe(false);
		expect(check(fromIp(BUNDLED_IP))).toBe(true);
	});

	it("accepts exactly 50,000 prefixes split across entries", async () => {
		const file = rulesFile({
			ipRanges: [
				{
					source: "a",
					bot: "A",
					ipv4: Array<string>(20_000).fill("192.0.2.0/24"),
					ipv6: Array<string>(10_000).fill("2001:db8::/32"),
				},
				{
					source: "b",
					bot: "B",
					ipv4: Array<string>(19_999).fill("198.18.0.0/16"),
					ipv6: ["2a0f:1::/32"],
				},
			],
		});
		const { check } = await load(json(file));
		expect(check(canaryRequest())).toBe(true);
		expect(check(fromIp("198.18.1.1"))).toBe(true);
		expect(check(fromIp("2a0f:1::9"))).toBe(true);
	});

	it("refuses 50,001 prefixes split across entries", async () => {
		const file = rulesFile({
			ipRanges: [
				{
					source: "a",
					bot: "A",
					ipv4: Array<string>(20_000).fill("192.0.2.0/24"),
					ipv6: Array<string>(10_000).fill("2001:db8::/32"),
				},
				{
					source: "b",
					bot: "B",
					ipv4: Array<string>(20_000).fill("198.18.0.0/16"),
					ipv6: ["2a0f:1::/32"],
				},
			],
		});
		const { check } = await load(json(file));
		expect(check(canaryRequest())).toBe(false);
		expect(check(fromIp(BUNDLED_IP))).toBe(true);
	});
});

describe("rules refresh: windows", () => {
	async function attemptsAt(first: Handler, elapsed: number, later?: Handler) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const relay = await freshRelay();
		let handler = first;
		const { calls } = stubFetch({
			[RULES_URL]: (url, init) => handler(url, init),
		});
		const background = collector();
		const options: IsAgentOptions = {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		};
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		if (later) {
			handler = later;
		}
		vi.setSystemTime(T0 + elapsed);
		relay.isAgent(ua("curl/8.7.1"), options);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		return {
			attempts: rulesCalls(calls).length,
			check: (request: Request) => relay.isAgent(request, options),
			calls,
			options,
			relay,
			background,
		};
	}

	const valid = json(rulesFile());
	const failing = json(rulesFile(), 500);
	const invalid = json(rulesFile({ tokens: [CANARY, "zqx"] }));

	it("after a swap: no new fetch at 12 h minus 1 ms", async () => {
		expect((await attemptsAt(valid, 12 * HOUR - 1)).attempts).toBe(1);
	});

	it("after a swap: one new fetch at exactly 12 h", async () => {
		expect((await attemptsAt(valid, 12 * HOUR)).attempts).toBe(2);
	});

	it("after a swap: one new fetch at 12 h plus 1 ms", async () => {
		expect((await attemptsAt(valid, 12 * HOUR + 1)).attempts).toBe(2);
	});

	it("after a swap: no retry at 5 min", async () => {
		expect((await attemptsAt(valid, 5 * MINUTE)).attempts).toBe(1);
	});

	it("after a swap: no retry at 5 min plus 1 ms", async () => {
		expect((await attemptsAt(valid, 5 * MINUTE + 1)).attempts).toBe(1);
	});

	it.each<[string, Handler]>([
		["a failed fetch", failing],
		["an invalid file", invalid],
		["a network error", () => Promise.reject(new TypeError("fetch failed"))],
	])("after %s: no retry at 5 min minus 1 ms", async (_name, first) => {
		expect((await attemptsAt(first, 5 * MINUTE - 1)).attempts).toBe(1);
	});

	it.each<[string, Handler]>([
		["a failed fetch", failing],
		["an invalid file", invalid],
		["a network error", () => Promise.reject(new TypeError("fetch failed"))],
	])("after %s: one retry at exactly 5 min", async (_name, first) => {
		expect((await attemptsAt(first, 5 * MINUTE)).attempts).toBe(2);
	});

	it.each<[string, Handler]>([
		["a failed fetch", failing],
		["an invalid file", invalid],
	])("after %s: one retry at 5 min plus 1 ms", async (_name, first) => {
		expect((await attemptsAt(first, 5 * MINUTE + 1)).attempts).toBe(2);
	});

	it("a retry after a failure applies a valid file", async () => {
		const { attempts, check } = await attemptsAt(failing, 5 * MINUTE, valid);
		expect(attempts).toBe(2);
		expect(check(canaryRequest())).toBe(true);
		expect(check(ua(GPTBOT_UA))).toBe(false);
	});

	it("only one attempt per retry window, then the next window opens 5 min after that attempt", async () => {
		const { relay, calls, options, background } = await attemptsAt(
			failing,
			5 * MINUTE,
		);
		expect(rulesCalls(calls)).toHaveLength(2);
		vi.setSystemTime(T0 + 10 * MINUTE - 1);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		expect(rulesCalls(calls)).toHaveLength(2);
		vi.setSystemTime(T0 + 10 * MINUTE);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		expect(rulesCalls(calls)).toHaveLength(3);
	});

	const afterSwapFailures: Array<[string, Handler]> = [
		["a non-2xx", json(rulesFile(), 500)],
		["an invalid file", json(rulesFile({ tokens: [CANARY, "zqx"] }))],
		["a network error", () => Promise.reject(new TypeError("fetch failed"))],
	];

	it.each(
		afterSwapFailures.flatMap(([name, handler]) =>
			[
				[-1, 2],
				[0, 3],
				[1, 3],
			].map(([offset, expected]): [string, Handler, number, number] => [
				name,
				handler,
				offset ?? 0,
				expected ?? 0,
			]),
		),
	)(
		"after a swap then %s at 12 h: keeps the remote rules, and at 5 min %i ms after that attempt has made %i attempts",
		async (_name, handler, offset, expected) => {
			const { attempts, check, relay, calls, options, background } =
				await attemptsAt(valid, 12 * HOUR, handler);
			expect(attempts).toBe(2);
			expect(check(canaryRequest())).toBe(true);
			expect(check(ua(GPTBOT_UA))).toBe(false);
			expect(check(fromIp("192.0.2.5"))).toBe(true);
			expect(check(fromIp(BUNDLED_IP))).toBe(false);
			vi.setSystemTime(T0 + 12 * HOUR + 5 * MINUTE + offset);
			relay.isAgent(ua("curl/8.7.1"), options);
			relay.isAgent(ua("curl/8.7.1"), options);
			await background.flush();
			expect(rulesCalls(calls)).toHaveLength(expected);
			expect(check(canaryRequest())).toBe(true);
		},
	);

	it("after a swap then a failure, a successful retry at 5 min opens a 12 h window again", async () => {
		const { relay, calls, options, background } = await attemptsAt(
			valid,
			12 * HOUR,
			failing,
		);
		const failedAt = T0 + 12 * HOUR;
		vi.setSystemTime(failedAt + 5 * MINUTE);
		const second = json(rulesFile({ tokens: [SECOND] }));
		const { fetchMock } = stubFetch({ [RULES_URL]: second });
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		expect(rulesCalls(calls)).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(relay.isAgent(ua(`${SECOND}/1.0`), options)).toBe(true);
		expect(relay.isAgent(canaryRequest(), options)).toBe(false);
		vi.setSystemTime(failedAt + 10 * MINUTE);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		vi.setSystemTime(failedAt + 5 * MINUTE + 12 * HOUR - 1);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.setSystemTime(failedAt + 5 * MINUTE + 12 * HOUR);
		relay.isAgent(ua("curl/8.7.1"), options);
		await background.flush();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("an invalid refresh after a swap keeps the remote rules", async () => {
		const { attempts, check } = await attemptsAt(valid, 12 * HOUR, invalid);
		expect(attempts).toBe(2);
		expect(check(canaryRequest())).toBe(true);
		expect(check(ua(`${SECOND}/1.0`))).toBe(false);
	});

	it("a second valid file replaces the first", async () => {
		const { attempts, check } = await attemptsAt(
			valid,
			12 * HOUR,
			json(
				rulesFile({
					tokens: [SECOND],
					ipRanges: [
						{ source: "t", bot: "T", ipv4: ["203.0.113.0/24"], ipv6: [] },
					],
				}),
			),
		);
		expect(attempts).toBe(2);
		expect(check(ua(`${SECOND}/1.0`))).toBe(true);
		expect(check(canaryRequest())).toBe(false);
		expect(check(fromIp("203.0.113.9"))).toBe(true);
		expect(check(fromIp("192.0.2.5"))).toBe(false);
	});
});
