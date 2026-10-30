import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveMatchKey } from "../src/match-key";
import { collector, freshRelay, stubFetch } from "./helpers";

const ORG_KEY = "n2qibGz_0noxBqbFYI_P3xY0WiWLqVmTyKMczeYJ9oA";
const VECTORS = [
	[
		"198.51.100.23",
		"147f4028ec9108121e7db81ee465716c78ba887214ff89ee891e5cfe7e405c49",
	],
	[
		"203.0.113.10",
		"f88eba717a457c52331f1467bd7a7f35a5316e697ba3e0f39e1526d6caacfc05",
	],
] as const;
const ALLOWED_FIELDS = [
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
	"platform",
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("app contract", () => {
	it.each(VECTORS)(
		"derives the app's match key for %s",
		async (ip, expected) => {
			expect(await deriveMatchKey(ORG_KEY, ip)).toBe(expected);
		},
	);

	it("sends a record the strict app schema accepts", async () => {
		const relay = await freshRelay();
		const url = "https://app.test/api/v2/agent-traffic/ingest/middleware/tok";
		const { calls } = stubFetch({
			[url]: () => new Response(null, { status: 202 }),
		});
		const background = collector();
		relay.recordAgentVisit(
			new Request("https://www.example.com/", {
				headers: {
					"user-agent": "Claude-User/1.0",
					referer: "https://claude.ai/",
					"x-forwarded-for": " 198.51.100.23 ",
					authorization: "DPoP",
				},
			}),
			{
				key: `wwt_tok.${ORG_KEY}`,
				apiUrl: "https://app.test",
				waitUntil: background.waitUntil,
			},
		);
		await background.flush();
		const body = JSON.parse(
			String(calls.find((call) => call.url === url)?.init?.body),
		);
		const record = body.requests[0];
		expect(body.requests).toHaveLength(1);
		expect(
			Object.keys(record).every((key) => ALLOWED_FIELDS.includes(key)),
		).toBe(true);
		expect(record.matchKey).toBe(VECTORS[0][1]);
		expect(record.sourceEventId.length).toBeGreaterThan(0);
		expect(record.sourceEventId.length).toBeLessThanOrEqual(200);
		expect(record.relayVersion.length).toBeLessThanOrEqual(64);
		expect("authorization" in record.headers).toBe(false);
	});

	it("sends platform as a string the app schema accepts on a Cloudflare Worker", async () => {
		const relay = await freshRelay();
		const url = "https://app.test/api/v2/agent-traffic/ingest/middleware/tok";
		const { calls } = stubFetch({
			[url]: () => new Response(null, { status: 202 }),
		});
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const background = collector();
		relay.recordAgentVisit(
			new Request("https://www.example.com/", {
				headers: { "user-agent": "Claude-User/1.0" },
			}),
			{
				key: `wwt_tok.${ORG_KEY}`,
				apiUrl: "https://app.test",
				waitUntil: background.waitUntil,
			},
		);
		await background.flush();
		const record = JSON.parse(
			String(calls.find((call) => call.url === url)?.init?.body),
		).requests[0];
		expect(
			Object.keys(record).every((key) => ALLOWED_FIELDS.includes(key)),
		).toBe(true);
		expect(typeof record.platform).toBe("string");
		expect(record.platform).toBe("cloudflare");
	});
});
