import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFrontRequest } from "../src/index";
import {
	API_URL,
	agentRequest,
	collector,
	freshRelay,
	INGEST_TOKEN,
	INGEST_URL,
	ingestBodies,
	KEY,
	stubFetch,
} from "./helpers";

const RULES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/rules`;
const PAGES_URL = `${API_URL}/api/v2/agent-traffic/serve/${INGEST_TOKEN}/pages`;
const HOST = "www.example.com";
const CHATGPT_USER_UA =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

const ok = () => new Response(null, { status: 202 });

const rules = () =>
	Response.json({
		success: true,
		message: "success",
		data: {
			version: 1,
			pagesUrl: PAGES_URL,
			userAgentTokens: ["chatgpt-user", "claude-user"],
			deadlines: { headersMs: 50, bodyMs: 50 },
			maxBodyBytes: 16,
			sites: [
				{
					hostname: HOST,
					blockedUserAgentTokens: [],
					agentPages: { enabled: true, paths: ["/pricing"] },
				},
			],
		},
	});

const header = (key: string, value: string) => [{ key, value }];

const viewerRequest = (): CloudFrontRequest => ({
	clientIp: "198.51.100.23",
	method: "GET",
	uri: "/pricing",
	querystring: "",
	headers: {
		host: header("Host", HOST),
		"user-agent": header("User-Agent", CHATGPT_USER_UA),
	},
});

const options = { key: KEY, apiUrl: API_URL };

async function setup() {
	const relay = await freshRelay();
	const { calls } = stubFetch({ [INGEST_URL]: ok, [RULES_URL]: rules });
	const background = collector();
	const record = (request: Request | CloudFrontRequest) =>
		relay.recordAgentVisit(request, {
			...options,
			waitUntil: background.waitUntil,
		});
	const records = async () => {
		await background.flush();
		return ingestBodies(calls).flatMap((body) => body.requests);
	};
	return { relay, record, records };
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("WANIWANI_AGENT_TRAFFIC_KEY", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("recordAgentVisit: uses", () => {
	it("reports only recordAgentVisit in a fresh process with no other call", async () => {
		const { record, records } = await setup();
		record(agentRequest());
		const [posted] = await records();
		expect(posted.uses).toEqual(["recordAgentVisit"]);
	});

	it("leaves isAgent out of uses", async () => {
		const { relay, record, records } = await setup();
		expect(relay.isAgent(agentRequest(), { rules: "bundled" })).toBe(true);
		record(agentRequest());
		const [posted] = await records();
		expect(posted.uses).toEqual(["recordAgentVisit"]);
	});

	it("includes serveAgentPage called right after recordAgentVisit on the same tick", async () => {
		const { relay, record, records } = await setup();
		const request = agentRequest();
		record(request);
		const served = relay.serveAgentPage(request, options);
		const [posted] = await records();
		await served;
		expect([...posted.uses].sort()).toEqual(
			["recordAgentVisit", "serveAgentPage"].sort(),
		);
	});

	it("includes handleViewerRequest started after recordAgentVisit, the order of the generated viewer-request file", async () => {
		const { relay, record, records } = await setup();
		const request = viewerRequest();
		const visit = record(JSON.parse(JSON.stringify(request)));
		await relay.handleViewerRequest(request, options);
		await visit;
		const [posted] = await records();
		expect([...posted.uses].sort()).toEqual(
			["handleViewerRequest", "recordAgentVisit"].sort(),
		);
		expect(posted.path).toBe("/pricing");
	});

	it("keeps the original path when the viewer request marks the same request object", async () => {
		const { relay, record, records } = await setup();
		const request = viewerRequest();
		const visit = record(request);
		await relay.handleViewerRequest(request, options);
		await visit;
		expect(request.uri).not.toBe("/pricing");
		const [posted] = await records();
		expect(posted.path).toBe("/pricing");
		expect(posted.uses).toContain("handleViewerRequest");
	});

	it("includes serveAgentPage called before recordAgentVisit", async () => {
		const { relay, record, records } = await setup();
		const request = agentRequest();
		await relay.serveAgentPage(request, options);
		record(request);
		const [posted] = await records();
		expect([...posted.uses].sort()).toEqual(
			["recordAgentVisit", "serveAgentPage"].sort(),
		);
	});

	it("keeps a call from an earlier request in the same process", async () => {
		const { relay, record, records } = await setup();
		await relay.handleViewerRequest(viewerRequest(), options);
		record(agentRequest());
		record(agentRequest());
		const posted = await records();
		expect(posted).toHaveLength(2);
		for (const one of posted) {
			expect([...one.uses].sort()).toEqual(
				["handleViewerRequest", "recordAgentVisit"].sort(),
			);
		}
	});

	it("lists each function once however many times the process called it", async () => {
		const { relay, record, records } = await setup();
		const request = agentRequest();
		await relay.serveAgentPage(request, options);
		await relay.serveAgentPage(request, options);
		record(request);
		record(request);
		const posted = await records();
		for (const one of posted) {
			expect(one.uses).toHaveLength(2);
			expect(new Set(one.uses).size).toBe(one.uses.length);
		}
	});

	it("starts empty again in a new process", async () => {
		const first = await setup();
		await first.relay.serveAgentPage(agentRequest(), options);
		const second = await setup();
		second.record(agentRequest());
		const [posted] = await second.records();
		expect(posted.uses).toEqual(["recordAgentVisit"]);
	});
});
