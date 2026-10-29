import { settings } from "./settings";

export type Outcome = { status: number } | { failure: "timeout" | "network" };

/** One fetch bounded by the request timeout. Never rejects. */
export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Outcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		await response.body?.cancel().catch(() => {});
		return { status: response.status };
	} catch {
		return { failure: controller.signal.aborted ? "timeout" : "network" };
	} finally {
		clearTimeout(timer);
	}
}

export const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
