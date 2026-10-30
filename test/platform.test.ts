import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	API_URL,
	agentRequest,
	collector,
	freshRelay,
	INGEST_URL,
	ingestBodies,
	KEY,
	stubFetch,
} from "./helpers";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const ok = () => new Response(null, { status: 202 });

beforeEach(() => {
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", KEY);
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function setVercelStore(store: unknown) {
	Reflect.set(globalThis, REQUEST_CONTEXT, store);
}

async function recordOne(options: Record<string, unknown> = {}) {
	const relay = await freshRelay();
	const { calls } = stubFetch({ [INGEST_URL]: ok });
	const background = collector();
	relay.recordAgentVisit(agentRequest({ "x-forwarded-for": "203.0.113.7" }), {
		apiUrl: API_URL,
		waitUntil: background.waitUntil,
		...options,
	});
	await background.flush();
	return { bodies: ingestBodies(calls), calls };
}

async function recordedPlatform(options: Record<string, unknown> = {}) {
	const { bodies } = await recordOne(options);
	expect(bodies).toHaveLength(1);
	const record = bodies[0].requests[0];
	return { present: "platform" in record, value: record.platform };
}

describe("platform: Vercel", () => {
	it("sends vercel when the request context store returns a context", async () => {
		setVercelStore({ get: () => ({ waitUntil: () => {} }) });
		expect(await recordedPlatform()).toEqual({
			present: true,
			value: "vercel",
		});
	});

	it("sends vercel for a context without waitUntil", async () => {
		setVercelStore({ get: () => ({}) });
		expect((await recordedPlatform()).value).toBe("vercel");
	});

	it("leaves the field out when the store's get() returns undefined", async () => {
		setVercelStore({ get: () => undefined });
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("leaves the field out when the store's get() returns null", async () => {
		setVercelStore({ get: () => null });
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("leaves the field out when the store has no get", async () => {
		setVercelStore({});
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("still records the visit when get() throws", async () => {
		setVercelStore({
			get: () => {
				throw new Error("outside a request");
			},
		});
		const { bodies } = await recordOne();
		expect(bodies).toHaveLength(1);
		expect("platform" in bodies[0].requests[0]).toBe(false);
	});

	it("still records the visit when get is not a function", async () => {
		setVercelStore({ get: 42 });
		const { bodies } = await recordOne();
		expect(bodies).toHaveLength(1);
		expect("platform" in bodies[0].requests[0]).toBe(false);
	});

	it("reads the store's get() for each request", async () => {
		let context: object | undefined;
		setVercelStore({ get: () => context });
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const background = collector();
		const options = { apiUrl: API_URL, waitUntil: background.waitUntil };
		relay.recordAgentVisit(agentRequest(), options);
		context = {};
		relay.recordAgentVisit(agentRequest(), options);
		await background.flush();
		const records = ingestBodies(calls).map((body) => body.requests[0]);
		expect(records.map((record) => record.platform)).toEqual([
			undefined,
			"vercel",
		]);
	});
});

describe("platform: Cloudflare", () => {
	it("sends cloudflare when navigator.userAgent is Cloudflare-Workers", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		expect(await recordedPlatform()).toEqual({
			present: true,
			value: "cloudflare",
		});
	});

	it.each([
		["Node.js/24"],
		["Mozilla/5.0"],
		["cloudflare-workers"],
		["Cloudflare-Workers "],
		["Cloudflare-Workers/2"],
		[""],
	])("leaves the field out for navigator.userAgent %j", async (userAgent) => {
		vi.stubGlobal("navigator", { userAgent });
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("leaves the field out when navigator has no userAgent", async () => {
		vi.stubGlobal("navigator", {});
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("leaves the field out when there is no navigator", async () => {
		vi.stubGlobal("navigator", undefined);
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("leaves the field out when navigator is null", async () => {
		vi.stubGlobal("navigator", null);
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("still records the visit when reading navigator.userAgent throws", async () => {
		vi.stubGlobal("navigator", {
			get userAgent() {
				throw new Error("denied");
			},
		});
		const { bodies } = await recordOne();
		expect(bodies).toHaveLength(1);
		expect("platform" in bodies[0].requests[0]).toBe(false);
	});
});

describe("platform: order", () => {
	it("sends vercel when both the Vercel context and the Cloudflare userAgent are present", async () => {
		setVercelStore({ get: () => ({}) });
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		expect((await recordedPlatform()).value).toBe("vercel");
	});

	it("falls through to cloudflare when the Vercel store returns no context", async () => {
		setVercelStore({ get: () => undefined });
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		expect((await recordedPlatform()).value).toBe("cloudflare");
	});

	it("leaves the field out on a runtime that is neither", async () => {
		vi.stubGlobal("navigator", { userAgent: "Deno/2.0" });
		expect((await recordedPlatform()).present).toBe(false);
	});

	it("uses the platform at the time of the call, not at the time of the post", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const background = collector();
		relay.recordAgentVisit(agentRequest(), {
			apiUrl: API_URL,
			waitUntil: background.waitUntil,
		});
		vi.stubGlobal("navigator", { userAgent: "Node.js/24" });
		await background.flush();
		expect(ingestBodies(calls)[0].requests[0].platform).toBe("cloudflare");
	});
});

describe("platform: the other fields", () => {
	it("keeps every other field and omit rule when the platform is set", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const relay = await freshRelay();
		const { calls } = stubFetch({ [INGEST_URL]: ok });
		const background = collector();
		relay.recordAgentVisit(
			agentRequest({
				referer: "https://claude.ai/",
				accept: "text/html",
				"x-forwarded-for": "203.0.113.7",
			}),
			{
				apiUrl: API_URL,
				waitUntil: background.waitUntil,
				omit: ["userAgent", "matchKey", "accept"],
			},
		);
		await background.flush();
		const record = ingestBodies(calls)[0].requests[0];
		expect(Object.keys(record).sort()).toEqual(
			[
				"occurredAt",
				"method",
				"host",
				"path",
				"referer",
				"headers",
				"sourceEventId",
				"relayVersion",
				"platform",
			].sort(),
		);
		expect(record.headers).toEqual({ referer: "https://claude.ai/" });
		expect(record.platform).toBe("cloudflare");
	});

	it("does not let omit remove platform", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const { value } = await recordedPlatform({ omit: ["platform"] });
		expect(value).toBe("cloudflare");
	});

	it("sends the match key alongside the platform", async () => {
		setVercelStore({ get: () => ({}) });
		const { bodies } = await recordOne();
		const record = bodies[0].requests[0];
		expect(record.matchKey).toMatch(/^[0-9a-f]{64}$/);
		expect(record.platform).toBe("vercel");
	});

	it("leaves the record shape alone on plain Node", async () => {
		const { bodies } = await recordOne();
		expect("platform" in bodies[0].requests[0]).toBe(false);
	});

	it("keeps the public API to isAgent and recordAgentVisit", async () => {
		const relay = await import("../src/index");
		expect(Object.keys(relay).sort()).toEqual(["isAgent", "recordAgentVisit"]);
	});

	it("isAgent stays a pure header check with a platform present", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		setVercelStore({
			get: () => {
				throw new Error("boom");
			},
		});
		const relay = await freshRelay();
		const { fetchMock } = stubFetch({});
		expect(relay.isAgent(agentRequest())).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

const dist = new URL("../dist/index.js", import.meta.url);

const workerScript = `
Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true, writable: true });
const result = {};
try {
	const relay = await import(${JSON.stringify(dist.href)});
	const posted = [];
	globalThis.fetch = async (url, init) => {
		posted.push(JSON.parse(init.body).requests[0].platform ?? null);
		return new Response(null, { status: 202 });
	};
	const pending = [];
	relay.recordAgentVisit(
		new Request("https://example.com/", { headers: { "user-agent": "Claude-User/1.0" } }),
		{ apiUrl: "https://relay.test", key: "wwt_tok.b3Jn", waitUntil: (promise) => pending.push(promise) },
	);
	await Promise.all(pending);
	result.posted = posted;
} catch (error) {
	result.error = String(error);
}
console.log(JSON.stringify(result));
`;

describe("platform: the built module", () => {
	it("sends cloudflare from dist in a Worker-like runtime", () => {
		expect(existsSync(dist), "run `bun run build` before the tests").toBe(true);
		const output = execFileSync(process.execPath, [
			"--input-type=module",
			"-e",
			workerScript,
		]).toString();
		expect(JSON.parse(output)).toEqual({ posted: ["cloudflare"] });
	});
});
