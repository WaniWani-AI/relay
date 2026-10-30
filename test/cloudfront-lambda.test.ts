import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const dist = new URL("../dist/index.js", import.meta.url);
const ORG_KEY = "b3JnLWtleS1zZWNyZXQ";
const KEY = `wwt_tok-EN_123.${ORG_KEY}`;
const CLIENT_IP = "198.51.100.23";

const handlerSource = (apiUrl: string) => `
import { isAgent, recordAgentVisit } from "./relay.mjs";

export const handler = async (event) => {
	const request = event.Records[0].cf.request;
	if (isAgent(request)) {
		await recordAgentVisit(request, { key: ${JSON.stringify(KEY)}, apiUrl: ${JSON.stringify(apiUrl)} });
	}
	return request;
};
`;

const runnerSource = `
import { createServer } from "node:http";

const received = [];
let answered = 0;
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		received.push({ method: req.method, url: req.url, body: JSON.parse(body) });
		setTimeout(() => {
			res.writeHead(202);
			res.end();
			answered++;
		}, 150);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = "http://127.0.0.1:" + server.address().port;

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./index.mjs", import.meta.url), process.argv[2].replace("__API_URL__", apiUrl));
const { handler } = await import("./index.mjs");

const event = JSON.parse(process.argv[3]);
const before = JSON.stringify(event.Records[0].cf.request);
const started = Date.now();
const returned = await handler(event);
const elapsed = Date.now() - started;
const atResolve = { received: received.length, answered };
await new Promise((resolve) => setTimeout(resolve, 300));
server.close();
console.log(JSON.stringify({
	atResolve,
	later: received.length,
	received,
	elapsed,
	sameObject: returned === event.Records[0].cf.request,
	unchanged: JSON.stringify(returned) === before,
}));
`;

function viewerRequestEvent(userAgent: string) {
	return {
		Records: [
			{
				cf: {
					config: {
						distributionDomainName: "d111111abcdef8.cloudfront.net",
						distributionId: "EDFDVBD6EXAMPLE",
						eventType: "viewer-request",
						requestId:
							"4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==",
					},
					request: {
						clientIp: CLIENT_IP,
						method: "GET",
						uri: "/pricing/plans",
						querystring: "utm_source=chatgpt.com&page=2",
						headers: {
							host: [{ key: "Host", value: "www.example.com" }],
							"user-agent": [{ key: "User-Agent", value: userAgent }],
							"x-forwarded-for": [
								{ key: "X-Forwarded-For", value: "20.125.66.81" },
							],
							accept: [{ key: "Accept", value: "text/html" }],
							cookie: [{ key: "Cookie", value: "session=SECRET_COOKIE" }],
						},
					},
				},
			},
		],
	};
}

let folder = "";

beforeAll(() => {
	folder = mkdtempSync(join(tmpdir(), "relay-lambda-"));
});

afterAll(() => {
	rmSync(folder, { recursive: true, force: true });
});

async function invoke(userAgent: string, name: string) {
	const dir = join(folder, name);
	mkdirSync(dir);
	copyFileSync(dist, join(dir, "relay.mjs"));
	writeFileSync(join(dir, "runner.mjs"), runnerSource);
	const { stdout } = await run(
		process.execPath,
		[
			join(dir, "runner.mjs"),
			handlerSource("__API_URL__"),
			JSON.stringify(viewerRequestEvent(userAgent)),
		],
		{ cwd: dir, env: { PATH: process.env.PATH ?? "" } },
	);
	return { result: JSON.parse(stdout), dir };
}

describe("Lambda@Edge: the built module as relay.mjs", () => {
	it("is one file whose only import is node:net", () => {
		expect(existsSync(dist), "run `bun run build` before the tests").toBe(true);
		const source = readFileSync(dist, "utf8");
		const imports = [
			...source.matchAll(
				/(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
			),
			...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
			...source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g),
		].map((match) => match[1]);
		expect([...new Set(imports)]).toEqual(["node:net"]);
	});

	it("posts one event for a GPTBot request before the handler resolves", async () => {
		const { result, dir } = await invoke(
			"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
			"gptbot",
		);
		expect(readdirSync(dir).sort()).toEqual([
			"index.mjs",
			"relay.mjs",
			"runner.mjs",
		]);
		expect(result.atResolve).toEqual({ received: 1, answered: 1 });
		expect(result.later).toBe(1);
		expect(result.elapsed).toBeGreaterThanOrEqual(140);
		expect(result.sameObject).toBe(true);
		expect(result.unchanged).toBe(true);
		const [post] = result.received;
		expect(post.method).toBe("POST");
		expect(post.url).toBe("/api/v2/agent-traffic/ingest/middleware/tok-EN_123");
		expect(post.body.requests).toHaveLength(1);
		const record = post.body.requests[0];
		expect(record.platform).toBe("cloudfront");
		expect(record.host).toBe("www.example.com");
		expect(record.path).toBe("/pricing/plans?utm_source=chatgpt.com&page=2");
		expect(record.method).toBe("GET");
		expect(record.matchKey).toBe(
			createHmac("sha256", ORG_KEY).update(CLIENT_IP).digest("hex"),
		);
		expect(record.matchKey).not.toBe(
			createHmac("sha256", ORG_KEY).update("20.125.66.81").digest("hex"),
		);
		expect(record.headers).toEqual({
			"user-agent":
				"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
			accept: "text/html",
		});
		const raw = JSON.stringify(post.body);
		expect(raw).not.toContain(CLIENT_IP);
		expect(raw).not.toContain("SECRET_COOKIE");
	});

	it("posts nothing for a Chrome request and returns it unchanged", async () => {
		const { result } = await invoke(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			"chrome",
		);
		expect(result.atResolve.received).toBe(0);
		expect(result.later).toBe(0);
		expect(result.sameObject).toBe(true);
		expect(result.unchanged).toBe(true);
	});
});
