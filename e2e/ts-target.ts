import { createServer } from "node:http";
import { isAgent, recordAgentVisit, serveAgentPage } from "../src/index";

const port = Number(process.env.PORT ?? 8090);
const apiUrl = process.env.WANIWANI_API_URL ?? "http://127.0.0.1:4600";
const pending: Array<Promise<unknown>> = [];
const options = {
	apiUrl,
	key: process.env.WANIWANI_AGENT_TRAFFIC_KEY ?? "wwt_e2e.b3JnLWtleQ",
	waitUntil: (work: Promise<unknown>) => pending.push(work),
};

function originAnswer(
	path: string,
	method: string,
	body: Uint8Array,
): Response {
	const headers = {
		"x-origin": "1",
		"content-type": "text/html; charset=utf-8",
	};
	const url = new URL(path, "http://origin");
	if (method === "POST" && url.pathname === "/ask") {
		return new Response(`ask-origin:${body.byteLength}`, { headers });
	}
	if (method === "POST" && url.pathname === "/form") {
		const form = new URLSearchParams(new TextDecoder().decode(body));
		return new Response(`form:${form.get("name") ?? ""}`, { headers });
	}
	return new Response(`<h1>origin ${url.pathname}</h1>`, { headers });
}

createServer(async (incoming, outgoing) => {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) {
		chunks.push(chunk);
	}
	const body = new Uint8Array(Buffer.concat(chunks));
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") {
			headers.set(name, value);
		}
	}
	const method = incoming.method ?? "GET";
	const request = new Request(
		`http://${incoming.headers.host}${incoming.url}`,
		{
			method,
			headers,
			body: method === "GET" || method === "HEAD" ? undefined : body,
		},
	);
	if (isAgent(request, options)) {
		recordAgentVisit(request, options);
	}
	const answer =
		(await serveAgentPage(request, options)) ??
		originAnswer(incoming.url ?? "/", method, body);
	const out: Record<string, string> = {};
	answer.headers.forEach((value, name) => {
		out[name] = value;
	});
	outgoing.writeHead(answer.status, out);
	outgoing.end(
		method === "HEAD" ? undefined : Buffer.from(await answer.arrayBuffer()),
	);
}).listen(port, "127.0.0.1", () => {
	console.log(`TypeScript relay target on http://127.0.0.1:${port}`);
});
