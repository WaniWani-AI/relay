import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	API_URL,
	agentRequest,
	collector,
	freshRelay,
	type Handler,
	hang,
	INGEST_URL,
	KEY,
	stubFetch,
} from "./helpers";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const status =
	(code: number): Handler =>
	() =>
		new Response(null, { status: code });
const networkError: Handler = () => {
	throw new TypeError("fetch failed");
};

async function send(responses: Handler[]) {
	const relay = await freshRelay();
	relay.settings.requestTimeoutMs = 50;
	relay.settings.retryDelayMs = 30;
	let attempt = 0;
	const times: number[] = [];
	const { calls } = stubFetch({
		[INGEST_URL]: (url, init) => {
			times.push(Date.now());
			const handler = responses[Math.min(attempt, responses.length - 1)];
			attempt++;
			if (!handler) {
				throw new Error("no handler");
			}
			return handler(url, init);
		},
	});
	const background = collector();
	relay.recordAgentVisit(agentRequest({ "x-forwarded-for": "203.0.113.7" }), {
		key: KEY,
		apiUrl: API_URL,
		waitUntil: background.waitUntil,
	});
	await background.flush();
	const posts = calls.filter((call) => call.url === INGEST_URL);
	return { posts, times };
}

describe("ingest retry", () => {
	it.each([
		["a network error", networkError],
		["a timeout", hang],
		["429", status(429)],
		["500", status(500)],
		["503", status(503)],
	])("retries once after %s with the same body", async (_name, failure) => {
		const { posts, times } = await send([failure, status(202)]);
		expect(posts).toHaveLength(2);
		expect(posts[0]?.init?.body).toBe(posts[1]?.init?.body);
		expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(25);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		["a network error", networkError, "network"],
		["a timeout", hang, "timeout"],
		["429", status(429), "status 429"],
		["500", status(500), "status 500"],
	])(
		"drops the event with one warning after two failures on %s",
		async (_name, failure, reason) => {
			const { posts } = await send([failure]);
			expect(posts).toHaveLength(2);
			expect(warn).toHaveBeenCalledTimes(1);
			const line = String(warn.mock.calls[0]?.[0]);
			expect(line).toContain(reason);
			expect(line).not.toContain("203.0.113.7");
			expect(line).not.toContain("tok-EN_123");
		},
	);

	it.each([400, 401, 403, 404, 409, 413, 422])(
		"does not retry a %i",
		async (code) => {
			const { posts } = await send([status(code)]);
			expect(posts).toHaveLength(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain(`status ${code}`);
		},
	);

	it.each([200, 201, 202, 204])("treats %i as delivered", async (code) => {
		const { posts } = await send([status(code)]);
		expect(posts).toHaveLength(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it("bounds a hanging server by the timeout", async () => {
		const started = Date.now();
		const { posts } = await send([hang]);
		expect(posts).toHaveLength(2);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("never rejects when fetch itself is broken", async () => {
		const relay = await freshRelay();
		vi.stubGlobal("fetch", () => {
			throw new Error("sync failure");
		});
		relay.settings.retryDelayMs = 1;
		const promises: Promise<unknown>[] = [];
		expect(() =>
			relay.recordAgentVisit(agentRequest(), {
				key: KEY,
				apiUrl: API_URL,
				waitUntil: (p) => promises.push(p),
			}),
		).not.toThrow();
		await expect(Promise.all(promises)).resolves.toBeDefined();
	});
});
