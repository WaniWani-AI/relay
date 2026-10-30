import { delay, fetchWithTimeout, type Outcome } from "./http";
import { settings } from "./settings";

const isSuccess = (outcome: Outcome) =>
	"status" in outcome && outcome.status >= 200 && outcome.status < 300;

const isRetryable = (outcome: Outcome) =>
	"failure" in outcome || outcome.status === 429 || outcome.status >= 500;

const describe = (outcome: Outcome) =>
	"failure" in outcome ? outcome.failure : `status ${outcome.status}`;

export type PostPolicy = { timeoutMs: number; retry: boolean };

const post = (url: string, body: string, timeoutMs: number) =>
	fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
		timeoutMs,
	);

/** Posts once, retries once on a timeout, network error, 429 or 5xx when the policy allows it, and never rejects. */
export async function postEvent(
	url: string,
	body: string,
	policy: PostPolicy = { timeoutMs: settings.requestTimeoutMs, retry: true },
): Promise<boolean> {
	let outcome = await post(url, body, policy.timeoutMs);
	if (policy.retry && !isSuccess(outcome) && isRetryable(outcome)) {
		await delay(settings.retryDelayMs);
		outcome = await post(url, body, policy.timeoutMs);
	}
	if (isSuccess(outcome)) {
		return true;
	}
	console.warn(
		`[@waniwani/relay] Could not record an agent visit (${describe(outcome)}). The event was dropped.`,
	);
	return false;
}
