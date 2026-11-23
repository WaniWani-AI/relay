import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

export type PageServiceMode = {
	status: number;
	contentType: string | null;
	body: string | null;
	headerDelayMs: number;
	retryAfter: string | null;
};

export type IngestMode =
	| { kind: "accept" }
	| { kind: "status"; status: number }
	| { kind: "delay"; ms: number }
	| { kind: "hang" };

export type SiteConfig = {
	hostname: string;
	blockedUserAgentTokens: string[];
	agentPages: { enabled: boolean; paths: string[] };
};

export type FakeState = {
	agentRulesDown: boolean;
	siteRulesDown: boolean;
	sites: SiteConfig[];
	deadlines: { headersMs: number; bodyMs: number; askMs: number };
	maxBodyBytes: number;
	pageService: PageServiceMode | null;
	ingest: IngestMode;
};

export type IngestAttempt = {
	at: number;
	token: string;
	status: number;
	records: Array<Record<string, unknown>>;
};
export type PageRequest = {
	at: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
};

const readJson = (path: string): unknown =>
	JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const agents = readJson("../src/logic/agents.generated.json") as {
	tokens: string[];
};
const ranges = readJson("../src/logic/ip-ranges.generated.json") as {
	sources: Array<{ ipv4: string[]; ipv6: string[] }>;
};

export const defaultState = (hostname: string): FakeState => ({
	agentRulesDown: false,
	siteRulesDown: false,
	sites: [
		{
			hostname,
			blockedUserAgentTokens: ["gptbot"],
			agentPages: {
				enabled: true,
				paths: [
					"/",
					"/pricing",
					"/products/*",
					"/ask",
					"/cached",
					"/llms.txt",
					"/openapi.json",
				],
			},
		},
	],
	deadlines: { headersMs: 400, bodyMs: 400, askMs: 1500 },
	maxBodyBytes: 200_000,
	pageService: null,
	ingest: { kind: "accept" },
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function plainHeaders(request: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		if (value !== undefined) {
			out[name] = Array.isArray(value) ? value.join(", ") : value;
		}
	}
	return out;
}

export class FakeWaniwani {
	state: FakeState;
	attempts: IngestAttempt[] = [];
	pageRequests: PageRequest[] = [];
	agentRuleFetches = 0;
	siteRuleFetches = 0;
	readonly baseUrl: string;
	private server: Server | null = null;
	private hangs: ServerResponse[] = [];

	private readonly port: number;
	private readonly hostname: string;

	constructor(port: number, hostname: string) {
		this.port = port;
		this.hostname = hostname;
		this.state = defaultState(hostname);
		this.baseUrl = `http://127.0.0.1:${port}`;
	}

	reset() {
		this.state = defaultState(this.hostname);
		this.attempts = [];
		this.pageRequests = [];
		this.agentRuleFetches = 0;
		this.siteRuleFetches = 0;
		this.releaseHangs();
	}

	releaseHangs() {
		for (const response of this.hangs.splice(0)) {
			response.destroy();
		}
	}

	records(): Array<Record<string, unknown>> {
		return this.attempts
			.filter((attempt) => attempt.status >= 200 && attempt.status < 300)
			.flatMap((attempt) => attempt.records);
	}

	start(): Promise<void> {
		this.server = createServer((request, response) => {
			this.handle(request, response).catch(() => {
				response.destroy();
			});
		});
		return new Promise((resolve) =>
			this.server?.listen(this.port, "0.0.0.0", resolve),
		);
	}

	stop(): Promise<void> {
		this.releaseHangs();
		return new Promise((resolve) => {
			this.server?.closeAllConnections();
			this.server?.close(() => resolve());
		});
	}

	private async handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", this.baseUrl);
		const path = url.pathname;
		if (request.method === "GET" && path === "/api/v2/agent-traffic/rules") {
			this.agentRuleFetches++;
			if (this.state.agentRulesDown) {
				return json(response, 503, { success: false });
			}
			return json(response, 200, {
				success: true,
				data: { version: 1, tokens: agents.tokens, ipRanges: ranges.sources },
			});
		}
		const siteRules = /^\/api\/v2\/agent-traffic\/serve\/([^/]+)\/rules$/.exec(
			path,
		);
		if (request.method === "GET" && siteRules) {
			this.siteRuleFetches++;
			if (this.state.siteRulesDown) {
				return json(response, 503, { success: false });
			}
			return json(response, 200, {
				success: true,
				data: {
					version: 1,
					pagesUrl: `${this.baseUrl}/pages`,
					userAgentTokens: ["chatgpt-user", "claude-user", "perplexity-user"],
					deadlines: this.state.deadlines,
					maxBodyBytes: this.state.maxBodyBytes,
					sites: this.state.sites,
				},
			});
		}
		const ingest =
			/^\/api\/v2\/agent-traffic\/ingest\/middleware\/([^/]+)$/.exec(path);
		if (request.method === "POST" && ingest) {
			const body = await readBody(request);
			const mode = this.state.ingest;
			if (mode.kind === "hang") {
				this.hangs.push(response);
				return;
			}
			if (mode.kind === "delay") {
				await wait(mode.ms);
			}
			const status = mode.kind === "status" ? mode.status : 202;
			let records: Array<Record<string, unknown>> = [];
			try {
				const parsed = JSON.parse(body) as {
					requests?: Array<Record<string, unknown>>;
				};
				records = Array.isArray(parsed.requests) ? parsed.requests : [];
			} catch {}
			this.attempts.push({
				at: Date.now(),
				token: ingest[1] ?? "",
				status,
				records,
			});
			return json(response, status, { success: status < 300 });
		}
		if (path.startsWith("/pages/")) {
			const body = await readBody(request);
			const pagePath = path.slice("/pages".length) + url.search;
			this.pageRequests.push({
				at: Date.now(),
				method: request.method ?? "GET",
				path: pagePath,
				headers: plainHeaders(request),
				body,
			});
			const mode = this.state.pageService;
			const markdown = request.headers.accept === "text/markdown";
			const answer: PageServiceMode = mode ?? {
				status: 200,
				contentType: path.endsWith("/ask")
					? "application/json"
					: markdown
						? "text/markdown; charset=utf-8"
						: "text/html; charset=utf-8",
				body: path.endsWith("/ask")
					? JSON.stringify({ answer: "agent", question: body })
					: `agent page ${markdown ? "markdown" : "html"} ${pagePath}`,
				headerDelayMs: 0,
				retryAfter: null,
			};
			if (answer.headerDelayMs > 0) {
				await wait(answer.headerDelayMs);
			}
			const headers: Record<string, string> = {};
			if (answer.contentType) {
				headers["content-type"] = answer.contentType;
			}
			if (answer.retryAfter) {
				headers["retry-after"] = answer.retryAfter;
			}
			response.writeHead(answer.status, headers);
			response.end(answer.body ?? undefined);
			return;
		}
		json(response, 404, { success: false });
	}
}
