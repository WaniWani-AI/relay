import { exec, execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseArgs, promisify } from "node:util";
import { FakeWaniwani } from "./fake-waniwani.ts";
import { CLIENT_IP_HEADER, startProxy } from "./ogo-proxy.ts";

const { values: args } = parseArgs({
	options: {
		target: { type: "string", default: "http://127.0.0.1:8080" },
		"site-host": { type: "string", default: "www.e2e.test" },
		key: { type: "string", default: "wwt_e2e.b3JnLWtleQ" },
		platform: { type: "string", default: "aspnet" },
		suite: { type: "string", default: "default" },
		only: { type: "string" },
		"fake-port": { type: "string", default: "4600" },
		"proxy-port": { type: "string", default: "8081" },
		"proxy-source": { type: "string", default: "127.0.0.2" },
		"restart-cmd": { type: "string" },
		"memory-cmd": { type: "string" },
		slow: { type: "boolean", default: false },
		live: { type: "boolean", default: false },
		"page-path": { type: "string", default: "/" },
		"no-page-path": { type: "string" },
		"blocked-ua": { type: "string" },
		"waniwani-api": { type: "string" },
		"relay-version": { type: "string" },
	},
});

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const RELAY_VERSION = packageJson.version;
const TARGET = new URL(args.target);
const HOST = args.live ? TARGET.host : args["site-host"];
const ORG_KEY =
	/^wwt_[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+={0,2})$/.exec(args.key)?.[1] ?? "";
const PROXY_PORT = Number(args["proxy-port"]);
const DIRECT_IP = "127.0.0.1";

const CHATGPT =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const BROWSER =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const RECORD_FIELDS = new Set([
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
	"uses",
]);
const CAPPED = new Set([
	"user-agent",
	"referer",
	"accept",
	"accept-language",
	"from",
	"signature-agent",
	"signature-input",
	"signature",
	"dpop",
	"sec-ch-ua",
	"sec-ch-ua-platform",
	"sec-ch-ua-mobile",
	"authorization",
]);

const ranges = JSON.parse(
	readFileSync(
		new URL("../src/logic/ip-ranges.generated.json", import.meta.url),
		"utf8",
	),
) as { sources: Array<{ ipv4: string[]; ipv6: string[] }> };
const AI_IPV4 =
	(
		ranges.sources.find((source) => source.ipv4.length > 0)?.ipv4[0] ??
		"0.0.0.0/32"
	).split("/")[0] ?? "";
const AI_IPV6 =
	(
		ranges.sources.find((source) => source.ipv6.length > 0)?.ipv6[0] ?? "::/128"
	).split("/")[0] ?? "";

type Reply = {
	status: number;
	headers: Record<string, string>;
	body: string;
	ms: number;
};
type Send = {
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
	via?: "direct" | "proxy";
	clientIp?: string;
};

function send(input: Send): Promise<Reply> {
	const viaProxy = input.via === "proxy";
	const url = viaProxy ? new URL(`http://127.0.0.1:${PROXY_PORT}`) : TARGET;
	const headers: Record<string, string> = { host: HOST, ...input.headers };
	if (viaProxy && input.clientIp) {
		headers[CLIENT_IP_HEADER] = input.clientIp;
	}
	if (input.body !== undefined) {
		headers["content-length"] = String(Buffer.byteLength(input.body));
	}
	const started = performance.now();
	const call = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const outgoing = call(
			{
				hostname: url.hostname,
				port: url.port,
				path: input.path,
				method: input.method ?? "GET",
				headers,
				servername: TARGET.hostname,
				agent: false,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const out: Record<string, string> = {};
					for (const [name, value] of Object.entries(response.headers)) {
						if (value !== undefined) {
							out[name] = Array.isArray(value) ? value.join(", ") : value;
						}
					}
					resolve({
						status: response.statusCode ?? 0,
						headers: out,
						body: Buffer.concat(chunks).toString("utf8"),
						ms: performance.now() - started,
					});
				});
			},
		);
		outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("timeout")));
		outgoing.on("error", reject);
		outgoing.end(input.body);
	});
}

class Failure extends Error {}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Failure(message);
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isAgentPage = (reply: Reply) =>
	reply.headers["x-waniwani-agent-page"] === "hit";
const isOrigin = (reply: Reply) =>
	reply.headers["x-origin"] === "1" && !isAgentPage(reply);

function expectAgentPage(reply: Reply, label: string) {
	check(reply.status === 200, `${label}: expected 200, got ${reply.status}`);
	check(
		isAgentPage(reply),
		`${label}: expected the agent page, got ${reply.body.slice(0, 80)}`,
	);
	check(
		reply.headers["cache-control"] === "private, no-store",
		`${label}: cache-control is ${reply.headers["cache-control"]}`,
	);
	check(
		reply.headers.vary === "user-agent, accept",
		`${label}: vary is ${reply.headers.vary}`,
	);
}

function expectOrigin(reply: Reply, label: string) {
	check(
		isOrigin(reply),
		`${label}: expected the origin page, got ${reply.status} ${JSON.stringify(reply.headers)}`,
	);
}

const matchKey = (ip: string) =>
	createHmac("sha256", Buffer.from(ORG_KEY, "utf8")).update(ip).digest("hex");

type Context = { fake: FakeWaniwani };

async function recordsWhere(
	context: Context,
	predicate: (record: Record<string, unknown>) => boolean,
	count: number,
	timeoutMs = 5000,
) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		const found = context.fake.records().filter(predicate);
		if (found.length >= count) {
			return found;
		}
		await wait(50);
	}
	return context.fake.records().filter(predicate);
}

let marker = 0;
const nextMarker = () =>
	`e2e${Date.now().toString(36)}${(marker++).toString(36)}`;
const byMarker = (value: string) => (record: Record<string, unknown>) =>
	typeof record.path === "string" && record.path.includes(value);

function validateRecord(
	record: Record<string, unknown>,
	expected: {
		method: string;
		path: string;
		ip: string | null;
		userAgent?: string;
	},
) {
	for (const field of Object.keys(record)) {
		check(RECORD_FIELDS.has(field), `record has the unknown field ${field}`);
	}
	check(record.method === expected.method, `record method is ${record.method}`);
	check(
		record.host === HOST.split(":")[0]?.toLowerCase(),
		`record host is ${record.host}`,
	);
	check(
		record.path === expected.path,
		`record path is ${record.path}, expected ${expected.path}`,
	);
	check(
		record.platform === (args.platform === "none" ? undefined : args.platform),
		`record platform is ${record.platform}`,
	);
	check(
		record.relayVersion === RELAY_VERSION,
		`record relayVersion is ${record.relayVersion}`,
	);
	check(
		Array.isArray(record.uses) &&
			record.uses.includes("recordAgentVisit") &&
			record.uses.includes("serveAgentPage"),
		`record uses is ${JSON.stringify(record.uses)}`,
	);
	check(
		typeof record.occurredAt === "string" &&
			!Number.isNaN(Date.parse(record.occurredAt)),
		"record occurredAt is not a date",
	);
	check(
		typeof record.sourceEventId === "string" &&
			/^[0-9a-f-]{36}$/.test(record.sourceEventId),
		"record sourceEventId is not a UUID",
	);
	const headers = record.headers as Record<string, string>;
	for (const name of Object.keys(headers)) {
		check(CAPPED.has(name), `record sends the header ${name}`);
	}
	if (expected.userAgent !== undefined) {
		check(
			record.userAgent === expected.userAgent,
			`record userAgent is ${record.userAgent}`,
		);
	}
	if (expected.ip !== null) {
		check(
			record.matchKey === matchKey(expected.ip),
			`record matchKey is not the HMAC of ${expected.ip}`,
		);
	}
}

type Scenario = {
	id: string;
	title: string;
	live?: boolean;
	needs?: "restart" | "slow";
	run: (context: Context) => Promise<void>;
};

const page = (path: string, marker: string) =>
	`${path}${path.includes("?") ? "&" : "?"}m=${marker}`;

function percentile(values: number[], p: number) {
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[
			Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
		] ?? 0
	);
}

const execAsync = promisify(exec);

async function restart() {
	await execAsync(args["restart-cmd"] ?? "");
}

async function warmUp() {
	const until = Date.now() + 60_000;
	while (Date.now() < until) {
		try {
			const reply = await send({
				path: "/",
				headers: { "user-agent": BROWSER },
			});
			if (reply.status === 200) {
				return;
			}
		} catch {}
		await wait(500);
	}
	throw new Failure("the site does not answer");
}

async function waitForSiteRules() {
	const until = Date.now() + 60_000;
	while (Date.now() < until) {
		try {
			const reply = await send({
				path: args["page-path"],
				headers: { "user-agent": CHATGPT },
			});
			if (isAgentPage(reply)) {
				return;
			}
		} catch {}
		await wait(1000);
	}
}

const defaultScenarios: Scenario[] = [
	{
		id: "D1",
		title: "A person loads the home page",
		run: async (context) => {
			const m = nextMarker();
			const reply = await send({
				path: page("/", m),
				headers: { "user-agent": BROWSER, accept: BROWSER_ACCEPT },
			});
			expectOrigin(reply, "D1");
			await wait(1500);
			check(
				context.fake.records().filter(byMarker(m)).length === 0,
				"D1: a person was recorded",
			);
		},
	},
	{
		id: "D2",
		title: "ChatGPT-User loads a product page",
		run: async (context) => {
			const m = nextMarker();
			const path = page("/pricing", m);
			const reply = await send({
				path,
				headers: {
					"user-agent": CHATGPT,
					referer: "https://chatgpt.com/",
					cookie: "session=secret",
				},
			});
			expectAgentPage(reply, "D2");
			check(
				reply.headers["content-type"]?.startsWith("text/html"),
				`D2: content-type is ${reply.headers["content-type"]}`,
			);
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "D2: no record");
			validateRecord(record, {
				method: "GET",
				path,
				ip: DIRECT_IP,
				userAgent: CHATGPT,
			});
			check(
				!JSON.stringify(record).includes("secret"),
				"D2: the record holds the cookie",
			);
			const sent = context.fake.pageRequests.find((request) =>
				request.path.includes(m),
			);
			check(
				sent?.headers["x-waniwani-relay"] === RELAY_VERSION,
				"D2: the page request has no x-waniwani-relay",
			);
			check(
				sent?.headers["x-waniwani-agent"] === CHATGPT,
				"D2: the page request has no x-waniwani-agent",
			);
			check(
				sent?.headers.accept === "text/html",
				`D2: the page request accept is ${sent?.headers.accept}`,
			);
		},
	},
	{
		id: "D3",
		title: "A browser UA from an IP in the AI ranges",
		run: async (context) => {
			const m = nextMarker();
			const path = page("/contact", m);
			const reply = await send({
				path,
				headers: { "user-agent": BROWSER },
				via: "proxy",
				clientIp: AI_IPV4,
			});
			expectOrigin(reply, "D3");
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "D3: no record");
			validateRecord(record, { method: "GET", path, ip: AI_IPV4 });
		},
	},
	{
		id: "D4",
		title: "Only a signature-agent header, or only a dpop header",
		run: async (context) => {
			const variants: Array<Record<string, string>> = [
				{ "signature-agent": '"https://chatgpt.com"' },
				{ dpop: "eyJhbGciOiJFUzI1NiJ9" },
			];
			for (const headers of variants) {
				const m = nextMarker();
				await send({
					path: page("/contact", m),
					headers: { "user-agent": BROWSER, ...headers },
				});
				const found = await recordsWhere(context, byMarker(m), 1);
				check(
					found.length === 1,
					`D4: no record for ${Object.keys(headers)[0]}`,
				);
			}
		},
	},
	{
		id: "D5",
		title: "An agent sends a bearer token",
		run: async (context) => {
			const m = nextMarker();
			await send({
				path: page("/contact", m),
				headers: {
					"user-agent": CHATGPT,
					authorization: "Bearer top-secret-token",
				},
			});
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "D5: no record");
			check(
				(record.headers as Record<string, string>).authorization === "Bearer",
				"D5: the record does not hold the scheme",
			);
			check(
				!JSON.stringify(record).includes("top-secret-token"),
				"D5: the record holds the token",
			);
		},
	},
	{
		id: "P1",
		title: "A person with Accept: text/markdown",
		live: true,
		run: async (context) => {
			const m = nextMarker();
			const reply = await send({
				path: args.live ? args["page-path"] : page("/pricing", m),
				headers: { "user-agent": BROWSER, accept: "text/markdown" },
			});
			expectAgentPage(reply, "P1");
			check(
				reply.headers["content-type"]?.startsWith("text/markdown"),
				`P1: content-type is ${reply.headers["content-type"]}`,
			);
			if (!args.live) {
				await wait(1000);
				check(
					context.fake.records().filter(byMarker(m)).length === 0,
					"P1: a person was recorded",
				);
			}
		},
	},
	{
		id: "P2",
		title: "HEAD from an agent",
		run: async () => {
			const reply = await send({
				method: "HEAD",
				path: page("/pricing", nextMarker()),
				headers: { "user-agent": CHATGPT },
			});
			expectAgentPage(reply, "P2");
			check(reply.body === "", "P2: HEAD has a body");
		},
	},
	{
		id: "P3",
		title: "An agent on a path without agent pages",
		live: true,
		run: async (context) => {
			const m = nextMarker();
			const path = page(
				args.live ? (args["no-page-path"] ?? "/") : "/contact",
				m,
			);
			const reply = await send({ path, headers: { "user-agent": CHATGPT } });
			check(!isAgentPage(reply), "P3: got an agent page");
			if (!args.live) {
				expectOrigin(reply, "P3");
				const [record] = await recordsWhere(context, byMarker(m), 1);
				check(record, "P3: no record");
				validateRecord(record, { method: "GET", path, ip: DIRECT_IP });
			}
		},
	},
	{
		id: "P4",
		title: "POST /ask at the body cap and above it",
		run: async (context) => {
			const atCap = JSON.stringify({ q: "x".repeat(16_384 - 8) });
			check(
				Buffer.byteLength(atCap) === 16_384,
				"P4: the test body has the wrong size",
			);
			const first = await send({
				method: "POST",
				path: "/ask",
				headers: { "user-agent": CHATGPT, "content-type": "application/json" },
				body: atCap,
			});
			expectAgentPage(first, "P4 at the cap");
			const sent = context.fake.pageRequests.at(-1);
			check(
				sent?.method === "POST" && sent.body === atCap,
				"P4: the page service did not get the whole body",
			);
			const over = `${atCap} `;
			const second = await send({
				method: "POST",
				path: "/ask",
				headers: { "user-agent": CHATGPT, "content-type": "application/json" },
				body: over,
			});
			expectOrigin(second, "P4 over the cap");
			check(
				second.body === `ask-origin:${Buffer.byteLength(over)}`,
				`P4: the site read ${second.body}`,
			);
		},
	},
	{
		id: "P5",
		title: "The page service rate limits /ask",
		run: async (context) => {
			context.fake.state.pageService = {
				status: 429,
				contentType: "application/json",
				body: '{"error":"slow down"}',
				headerDelayMs: 0,
				retryAfter: "30",
			};
			const reply = await send({
				method: "POST",
				path: "/ask",
				headers: { "user-agent": CHATGPT, "content-type": "application/json" },
				body: '{"q":"x"}',
			});
			check(reply.status === 429, `P5: status is ${reply.status}`);
			check(
				reply.headers["retry-after"] === "30",
				`P5: retry-after is ${reply.headers["retry-after"]}`,
			);
			check(isAgentPage(reply), "P5: no agent page header");
		},
	},
	{
		id: "P6",
		title: "The page service answers with a PDF",
		run: async (context) => {
			context.fake.state.pageService = {
				status: 200,
				contentType: "application/pdf",
				body: "%PDF-1.7",
				headerDelayMs: 0,
				retryAfter: null,
			};
			expectOrigin(
				await send({
					path: page("/pricing", nextMarker()),
					headers: { "user-agent": CHATGPT },
				}),
				"P6",
			);
		},
	},
	{
		id: "P7",
		title: "A request from the page renderer",
		run: async () => {
			expectOrigin(
				await send({
					path: page("/pricing", nextMarker()),
					headers: { "user-agent": CHATGPT, "x-waniwani-render": "1" },
				}),
				"P7",
			);
		},
	},
	{
		id: "P8",
		title: "The site can still read request bodies",
		run: async (context) => {
			const form = await send({
				method: "POST",
				path: "/form",
				headers: {
					"user-agent": BROWSER,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: "name=Ada&__RequestVerificationToken=abc",
			});
			check(form.body === "form:Ada", `P8: the form answer is ${form.body}`);
			context.fake.state.pageService = {
				status: 500,
				contentType: "text/plain",
				body: "boom",
				headerDelayMs: 0,
				retryAfter: null,
			};
			const body = '{"q":"what is the price?"}';
			const ask = await send({
				method: "POST",
				path: "/ask",
				headers: { "user-agent": CHATGPT, "content-type": "application/json" },
				body,
			});
			expectOrigin(ask, "P8 ask");
			check(
				ask.body === `ask-origin:${Buffer.byteLength(body)}`,
				`P8: the site read ${ask.body}`,
			);
		},
	},
	{
		id: "S1",
		title: "An agent fetches a static file",
		run: async () => {
			expectAgentPage(
				await send({ path: "/llms.txt", headers: { "user-agent": CHATGPT } }),
				"S1",
			);
		},
	},
	{
		id: "B1",
		title: "A blocked agent",
		live: true,
		run: async (context) => {
			const m = nextMarker();
			const userAgent = args.live
				? (args["blocked-ua"] ?? "")
				: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
			check(userAgent !== "", "B1 needs --blocked-ua");
			const reply = await send({
				path: page(args.live ? args["page-path"] : "/pricing", m),
				headers: { "user-agent": userAgent },
			});
			check(reply.status === 403, `B1: status is ${reply.status}`);
			check(
				reply.headers["x-waniwani-blocked"] === "1",
				"B1: no x-waniwani-blocked header",
			);
			if (!args.live) {
				check(
					(await recordsWhere(context, byMarker(m), 1)).length === 1,
					"B1: no record",
				);
			}
		},
	},
	{
		id: "F1",
		title: "The page service is slower than headersMs",
		run: async (context) => {
			context.fake.state.pageService = {
				status: 200,
				contentType: "text/markdown",
				body: "late",
				headerDelayMs: 2000,
				retryAfter: null,
			};
			const reply = await send({
				path: page("/pricing", nextMarker()),
				headers: { "user-agent": CHATGPT },
			});
			expectOrigin(reply, "F1");
			check(
				reply.ms < context.fake.state.deadlines.headersMs + 600,
				`F1: the request took ${Math.round(reply.ms)} ms`,
			);
		},
	},
	{
		id: "F2",
		title: "The page service fails",
		run: async (context) => {
			context.fake.state.pageService = {
				status: 500,
				contentType: "text/plain",
				body: "boom",
				headerDelayMs: 0,
				retryAfter: null,
			};
			expectOrigin(
				await send({
					path: page("/pricing", nextMarker()),
					headers: { "user-agent": CHATGPT },
				}),
				"F2",
			);
		},
	},
	{
		id: "F4",
		title: "The ingest endpoint answers 503",
		run: async (context) => {
			context.fake.state.ingest = { kind: "status", status: 503 };
			const m = nextMarker();
			const reply = await send({
				path: page("/contact", m),
				headers: { "user-agent": CHATGPT },
			});
			check(reply.ms < 500, `F4: the request took ${Math.round(reply.ms)} ms`);
			await wait(3000);
			const attempts = context.fake.attempts.filter((attempt) =>
				attempt.records.some(byMarker(m)),
			);
			check(
				attempts.length === 2,
				`F4: expected 2 attempts, got ${attempts.length}`,
			);
			const gap = (attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0);
			check(gap >= 450, `F4: the retry came after ${gap} ms`);
		},
	},
	{
		id: "F5",
		title: "The ingest endpoint does not answer during many agent requests",
		needs: "slow",
		run: async (context) => {
			const baseline: number[] = [];
			for (let index = 0; index < 200; index++) {
				baseline.push(
					(await send({ path: "/contact", headers: { "user-agent": BROWSER } }))
						.ms,
				);
			}
			context.fake.state.ingest = { kind: "hang" };
			const segment = 1500;
			const total = segment * 3;
			const latencies: number[] = [];
			const sendAgents = async (count: number) => {
				let next = 0;
				await Promise.all(
					Array.from({ length: 20 }, async () => {
						while (next < count) {
							next++;
							const reply = await send({
								path: "/contact",
								headers: { "user-agent": CHATGPT },
							});
							check(reply.status === 200, `F5: status ${reply.status}`);
							latencies.push(reply.ms);
						}
					}),
				);
			};
			try {
				await sendAgents(segment);
				const memoryFull = readMemory();
				await sendAgents(segment);
				const memorySecond = readMemory();
				await sendAgents(segment);
				const memoryThird = readMemory();
				const added = percentile(latencies, 99) - percentile(baseline, 99);
				console.log(
					`    F5: p99 ${percentile(latencies, 99).toFixed(1)} ms with ingest down, ${percentile(baseline, 99).toFixed(1)} ms for persons before`,
				);
				check(added < 50, `F5: p99 grew by ${added.toFixed(1)} ms`);
				if (
					memoryFull !== null &&
					memorySecond !== null &&
					memoryThird !== null
				) {
					const grown = [
						memorySecond - memoryFull,
						memoryThird - memorySecond,
					].map((bytes) => bytes / 1024 / 1024);
					console.log(
						`    F5: worker memory grew by ${grown.map((mb) => mb.toFixed(1)).join(" MB, then ")} MB in two segments of ${segment} requests, with the queue full`,
					);
					check(
						Math.min(...grown) < 32,
						`F5: memory grew by ${grown.map((mb) => mb.toFixed(1)).join(" MB and ")} MB with the queue full`,
					);
				}
			} finally {
				context.fake.state.ingest = { kind: "accept" };
				context.fake.releaseHangs();
			}
			await wait(8000);
			const received = context.fake
				.records()
				.filter((record) => record.path === "/contact").length;
			console.log(
				`    F5: ${received} of ${total} records arrived after the ingest came back`,
			);
			check(
				received <= 1200,
				`F5: ${received} records arrived, so the queue was not capped`,
			);
		},
	},
	{
		id: "I1",
		title: "A client forges X-Forwarded-For through the proxy",
		run: async (context) => {
			const m = nextMarker();
			const path = page("/contact", m);
			await send({
				path,
				headers: { "user-agent": CHATGPT, "x-forwarded-for": "6.6.6.6" },
				via: "proxy",
				clientIp: "9.9.9.9",
			});
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "I1: no record");
			validateRecord(record, { method: "GET", path, ip: "9.9.9.9" });
		},
	},
	{
		id: "I2",
		title: "A direct request with a forged X-Forwarded-For",
		run: async (context) => {
			const m = nextMarker();
			const path = page("/contact", m);
			await send({
				path,
				headers: { "user-agent": CHATGPT, "x-forwarded-for": "6.6.6.6" },
			});
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "I2: no record");
			validateRecord(record, { method: "GET", path, ip: DIRECT_IP });
		},
	},
	{
		id: "I3",
		title: "An IPv6 client in the AI ranges",
		run: async (context) => {
			const m = nextMarker();
			const path = page("/contact", m);
			await send({
				path,
				headers: { "user-agent": BROWSER },
				via: "proxy",
				clientIp: AI_IPV6,
			});
			const [record] = await recordsWhere(context, byMarker(m), 1);
			check(record, "I3: no record");
			validateRecord(record, {
				method: "GET",
				path,
				ip: AI_IPV6.toLowerCase(),
			});
		},
	},
	{
		id: "C1",
		title: "A cached page still gives agents the agent page",
		run: async () => {
			for (let index = 0; index < 3; index++) {
				expectOrigin(
					await send({
						path: "/cached",
						headers: { "user-agent": BROWSER, accept: BROWSER_ACCEPT },
					}),
					"C1 person",
				);
			}
			const reply = await send({
				path: "/cached",
				headers: { "user-agent": CHATGPT },
			});
			check(
				isAgentPage(reply),
				`C1: the agent got the cached origin page (cache: ${reply.headers["x-cache"] ?? "unknown"}). Turn off the kernel or output cache for this path.`,
			);
			const person = await send({
				path: "/cached",
				headers: { "user-agent": BROWSER, accept: BROWSER_ACCEPT },
			});
			expectOrigin(person, "C1 person after the agent");
		},
	},
	{
		id: "C2",
		title: "A cached page outside agent pages still blocks a blocked agent",
		run: async () => {
			for (let index = 0; index < 3; index++) {
				expectOrigin(
					await send({
						path: "/cached-not-served",
						headers: { "user-agent": BROWSER, accept: BROWSER_ACCEPT },
					}),
					"C2 person",
				);
			}
			const reply = await send({
				path: "/cached-not-served",
				headers: {
					"user-agent":
						"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
				},
			});
			check(
				reply.status === 403,
				`C2: the blocked agent got status ${reply.status} (cache: ${reply.headers["x-cache"] ?? "unknown"}). Turn off the kernel or output cache on sites that block agents.`,
			);
		},
	},
	{
		id: "F3",
		title: "The rules endpoints are down when the app pool starts",
		needs: "restart",
		run: async (context) => {
			context.fake.state.agentRulesDown = true;
			context.fake.state.siteRulesDown = true;
			await restart();
			const person = await send({
				path: "/contact",
				headers: { "user-agent": BROWSER },
			});
			expectOrigin(person, "F3 person");
			const agent = await send({
				path: page("/pricing", nextMarker()),
				headers: { "user-agent": CHATGPT },
			});
			expectOrigin(agent, "F3 agent");
			context.fake.state.agentRulesDown = false;
			context.fake.state.siteRulesDown = false;
			await wait(5500);
			expectAgentPage(
				await send({
					path: page("/pricing", nextMarker()),
					headers: { "user-agent": CHATGPT },
				}),
				"F3 after the rules came back",
			);
		},
	},
	{
		id: "L1",
		title: "The app pool recycles with records in the queue",
		needs: "restart",
		run: async (context) => {
			await send({ path: "/pricing", headers: { "user-agent": CHATGPT } });
			context.fake.state.ingest = { kind: "delay", ms: 500 };
			const m = nextMarker();
			await Promise.all(
				Array.from({ length: 200 }, (_, index) =>
					send({
						path: `/contact?m=${m}&n=${index}`,
						headers: { "user-agent": CHATGPT },
					}),
				),
			);
			const recycledAt = Date.now();
			await restart();
			const found = await recordsWhere(context, byMarker(m), 200, 8000);
			const last = Math.max(
				...context.fake.attempts
					.filter((attempt) => attempt.records.some(byMarker(m)))
					.map((attempt) => attempt.at),
			);
			console.log(
				`    L1: ${found.length} of 200 records arrived, the last ${last - recycledAt} ms after the recycle started`,
			);
			const timeline = context.fake.attempts
				.filter((attempt) => attempt.records.some(byMarker(m)))
				.map(
					(attempt) =>
						`${attempt.at - recycledAt} ms: ${attempt.records.length} records, status ${attempt.status}`,
				);
			console.log(
				`    L1: ingest calls after the recycle started: ${timeline.join("; ")}`,
			);
			check(found.length === 200, `L1: ${found.length} of 200 records arrived`);
		},
	},
	{
		id: "L2",
		title: "A change to the site rules applies without a restart",
		needs: "slow",
		run: async (context) => {
			expectAgentPage(
				await send({
					path: page("/pricing", nextMarker()),
					headers: { "user-agent": CHATGPT },
				}),
				"L2 before",
			);
			const site = context.fake.state.sites[0];
			check(site, "L2: no site");
			site.agentPages = { enabled: false, paths: [] };
			const until = Date.now() + 75_000;
			while (Date.now() < until) {
				if (
					isOrigin(
						await send({
							path: page("/pricing", nextMarker()),
							headers: { "user-agent": CHATGPT },
						}),
					)
				) {
					return;
				}
				await wait(2000);
			}
			throw new Failure("L2: the new site rules did not apply within 75 s");
		},
	},
];

const disabledScenarios: Scenario[] = [
	{
		id: "F7",
		title: "Waniwani:Enabled is false",
		run: async (context) => {
			expectOrigin(
				await send({ path: "/pricing", headers: { "user-agent": CHATGPT } }),
				"F7 agent",
			);
			expectOrigin(
				await send({
					path: "/pricing",
					headers: { "user-agent": BROWSER, accept: "text/markdown" },
				}),
				"F7 markdown",
			);
			await wait(1500);
			const calls =
				context.fake.attempts.length +
				context.fake.pageRequests.length +
				context.fake.siteRuleFetches +
				context.fake.agentRuleFetches;
			check(calls === 0, `F7: the module made ${calls} outbound calls`);
		},
	},
];

const badKeyScenarios: Scenario[] = [
	{
		id: "F6",
		title: "The key is not valid",
		run: async (context) => {
			expectOrigin(
				await send({ path: "/pricing", headers: { "user-agent": CHATGPT } }),
				"F6 agent",
			);
			expectOrigin(
				await send({ path: "/", headers: { "user-agent": BROWSER } }),
				"F6 person",
			);
			await wait(1500);
			check(context.fake.attempts.length === 0, "F6: the module sent records");
		},
	},
];

function readMemory(): number | null {
	if (!args["memory-cmd"]) {
		return null;
	}
	const value = Number(
		execSync(args["memory-cmd"], { encoding: "utf8" }).trim(),
	);
	return Number.isFinite(value) ? value : null;
}

type Website = {
	hostname: string;
	platform: string;
	middleware: {
		seenAt: string | null;
		relayVersion: string | null;
		uses: string[] | null;
	};
	lastAgentRequestAt: string | null;
};

async function waniwaniWebsite(): Promise<Website> {
	const token = process.env.WANIWANI_API_KEY ?? "";
	check(token !== "", "W1 needs WANIWANI_API_KEY");
	const response = await fetch(
		new URL("/api/v2/agent-traffic/sites", args["waniwani-api"]),
		{ headers: { authorization: `Bearer ${token}` } },
	);
	check(response.ok, `W1: the website list answered ${response.status}`);
	const body = (await response.json()) as {
		data?: { sites: Website[] };
		sites?: Website[];
	};
	const sites = body.data?.sites ?? body.sites ?? [];
	const site = sites.find((entry) => entry.hostname === TARGET.hostname);
	check(site, `W1: Waniwani has no website ${TARGET.hostname}`);
	return site;
}

const RUN_STARTED = Date.now();

const waniwaniReceived: Scenario = {
	id: "W1",
	title: "Waniwani received the visits and the relay calls",
	run: async () => {
		const version = args["relay-version"] ?? RELAY_VERSION;
		const after = (value: string | null) =>
			value !== null && Date.parse(value) >= RUN_STARTED - 5_000;
		let site = await waniwaniWebsite();
		for (
			let attempt = 0;
			attempt < 24 &&
			!(after(site.middleware.seenAt) && after(site.lastAgentRequestAt));
			attempt++
		) {
			await wait(5_000);
			site = await waniwaniWebsite();
		}
		check(
			after(site.lastAgentRequestAt),
			`W1: the last agent visit is ${site.lastAgentRequestAt}, before this run`,
		);
		check(
			after(site.middleware.seenAt),
			`W1: the relay was last seen ${site.middleware.seenAt}, before this run`,
		);
		check(
			site.middleware.relayVersion === version,
			`W1: the relay version is ${site.middleware.relayVersion}, expected ${version}`,
		);
		check(
			site.platform === args.platform,
			`W1: the platform is ${site.platform}, expected ${args.platform}`,
		);
		for (const use of ["recordAgentVisit", "serveAgentPage"]) {
			check(
				site.middleware.uses?.includes(use),
				`W1: the relay calls are ${JSON.stringify(site.middleware.uses)}, ${use} is missing`,
			);
		}
	},
};

async function main() {
	const suites: Record<string, Scenario[]> = {
		default: defaultScenarios,
		disabled: disabledScenarios,
		"bad-key": badKeyScenarios,
	};
	let scenarios = args.live
		? defaultScenarios.filter((scenario) => scenario.live)
		: (suites[args.suite] ?? []);
	if (args.live) {
		scenarios = [
			{
				id: "D1",
				title: "A person loads the page",
				run: async () => {
					check(
						!isAgentPage(
							await send({
								path: args["page-path"],
								headers: { "user-agent": BROWSER, accept: BROWSER_ACCEPT },
							}),
						),
						"D1: a person got the agent page",
					);
				},
			},
			{
				id: "D2",
				title: "ChatGPT-User loads the page",
				run: async () => {
					expectAgentPage(
						await send({
							path: args["page-path"],
							headers: { "user-agent": CHATGPT },
						}),
						"D2",
					);
				},
			},
			...scenarios.filter(
				(scenario) => scenario.id !== "B1" || args["blocked-ua"],
			),
			...(args["waniwani-api"] ? [waniwaniReceived] : []),
		];
	}
	if (args.only) {
		const only = new Set(args.only.split(","));
		scenarios = scenarios.filter((scenario) => only.has(scenario.id));
	}
	const fake = new FakeWaniwani(
		Number(args["fake-port"]),
		HOST.split(":")[0]?.toLowerCase() ?? "",
	);
	const servers: Array<{ close: () => void }> = [];
	if (!args.live) {
		await fake.start();
		servers.push(
			await startProxy({
				port: PROXY_PORT,
				target: TARGET,
				sourceAddress: args["proxy-source"],
			}),
		);
		await warmUp();
	} else {
		await waitForSiteRules();
	}
	let failed = 0;
	let skipped = 0;
	for (const scenario of scenarios) {
		if (
			(scenario.needs === "restart" && !args["restart-cmd"]) ||
			(scenario.needs === "slow" && !args.slow)
		) {
			skipped++;
			console.log(
				`SKIP ${scenario.id} ${scenario.title} (needs ${scenario.needs === "restart" ? "--restart-cmd" : "--slow"})`,
			);
			continue;
		}
		fake.reset();
		const started = Date.now();
		try {
			await scenario.run({ fake });
			console.log(
				`PASS ${scenario.id} ${scenario.title} (${Date.now() - started} ms)`,
			);
		} catch (error) {
			failed++;
			console.log(
				`FAIL ${scenario.id} ${scenario.title}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	console.log(
		`\n${scenarios.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
	);
	for (const server of servers) {
		server.close();
	}
	if (!args.live) {
		await fake.stop();
	}
	process.exit(failed > 0 ? 1 : 0);
}

await main();
