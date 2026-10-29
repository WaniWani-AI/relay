import { vi } from "vitest";

export const KEY = "wwt_tok-EN_123.b3JnLWtleS1zZWNyZXQ";
export const INGEST_TOKEN = "tok-EN_123";
export const ORG_KEY = "b3JnLWtleS1zZWNyZXQ";
export const API_URL = "https://relay.test";
export const INGEST_URL = `${API_URL}/api/v2/agent-traffic/ingest/middleware/${INGEST_TOKEN}`;

export type Call = { url: string; init: RequestInit | undefined };
export type Handler = (
	url: string,
	init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Replaces global fetch with a router; unknown URLs fail like a closed port. */
export function stubFetch(routes: Record<string, Handler>) {
	const calls: Call[] = [];
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			calls.push({ url, init });
			const handler = routes[url];
			if (!handler) {
				throw new TypeError("fetch failed");
			}
			return handler(url, init);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	return { calls, fetchMock };
}

export const ingestBodies = (calls: Call[]) =>
	calls
		.filter((call) => call.url === INGEST_URL)
		.map((call) => JSON.parse(String(call.init?.body)));

export function collector() {
	const pending: Promise<unknown>[] = [];
	return {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		async flush() {
			while (pending.length > 0) {
				await Promise.all(pending.splice(0));
			}
		},
	};
}

export function agentRequest(
	headers: Record<string, string> = {},
	url = "https://www.example.com:8443/pricing?x=1",
) {
	return new Request(url, {
		headers: {
			"user-agent": "Claude-User/1.0 (+https://anthropic.com)",
			...headers,
		},
	});
}

/** A promise that only settles when the fetch signal aborts, like a server that never answers. */
export const hang: Handler = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () =>
			reject(new DOMException("aborted", "AbortError")),
		);
	});

export async function freshRelay() {
	vi.resetModules();
	const relay = await import("../src/index");
	const { settings } = await import("../src/settings");
	return { ...relay, settings };
}
