import { createServer, request as httpRequest, type Server } from "node:http";

export const CLIENT_IP_HEADER = "x-e2e-client-ip";

/** A reverse proxy that acts like a CDN in front of the site: it connects from `sourceAddress` and appends the client IP to `X-Forwarded-For`. */
export function startProxy(input: {
	port: number;
	target: URL;
	sourceAddress: string;
}): Promise<Server> {
	const server = createServer((incoming, outgoing) => {
		const headers = { ...incoming.headers };
		const client = headers[CLIENT_IP_HEADER];
		delete headers[CLIENT_IP_HEADER];
		const existing = headers["x-forwarded-for"];
		const forwarded = [
			existing,
			typeof client === "string" ? client : "127.0.0.1",
		]
			.filter((value) => typeof value === "string" && value !== "")
			.join(", ");
		headers["x-forwarded-for"] = forwarded;
		const upstream = httpRequest(
			{
				hostname: input.target.hostname,
				port: input.target.port,
				path: incoming.url,
				method: incoming.method,
				headers,
				localAddress: input.sourceAddress,
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(outgoing);
			},
		);
		upstream.on("error", () => {
			outgoing.writeHead(502);
			outgoing.end("proxy error");
		});
		incoming.pipe(upstream);
	});
	return new Promise((resolve) =>
		server.listen(input.port, "127.0.0.1", () => resolve(server)),
	);
}
