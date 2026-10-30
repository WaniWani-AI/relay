// Writes src/logic/agents.json and src/logic/ip-ranges.generated.json from the
// rules file the WaniWani app serves, so the bundled fallback matches what the
// relay loads at run time. Run with `bun run rules`, review the diff, commit.
// RULES_URL overrides the source, for example a local app.

import { writeFile } from "node:fs/promises";
import { parseRemoteRules } from "../src/refresh";

const RULES_URL =
	process.env.RULES_URL ?? "https://app.waniwani.ai/api/v2/agent-traffic/rules";

type RemoteRange = {
	source: string;
	bot: string;
	ipv4: string[];
	ipv6: string[];
};

const isRemoteRange = (value: unknown): value is RemoteRange =>
	typeof value === "object" &&
	value !== null &&
	"source" in value &&
	typeof value.source === "string" &&
	"bot" in value &&
	typeof value.bot === "string";

const response = await fetch(RULES_URL, {
	signal: AbortSignal.timeout(15_000),
});
if (!response.ok) {
	throw new Error(`${RULES_URL} answered ${response.status}`);
}
const body: unknown = await response.json();
const rules = parseRemoteRules(body);
if (!rules) {
	throw new Error(
		`${RULES_URL} sent a rules file that fails the relay's checks`,
	);
}
const fields = typeof body === "object" && body !== null ? body : {};
const ranges =
	"ipRanges" in fields && Array.isArray(fields.ipRanges)
		? fields.ipRanges.filter(isRemoteRange)
		: [];
const hash = "hash" in fields ? String(fields.hash) : "unknown";

await writeFile(
	new URL("../src/logic/agents.json", import.meta.url),
	`${JSON.stringify(
		{
			source: `Built by scripts/build-rules.ts from the WaniWani rules file ${hash}. Each token is matched case-insensitively inside the User-Agent header.`,
			tokens: rules.tokens,
		},
		null,
		"\t",
	)}\n`,
);
await writeFile(
	new URL("../src/logic/ip-ranges.generated.json", import.meta.url),
	`${JSON.stringify(
		{
			sources: ranges.map((range) => ({
				bot: range.bot,
				url: range.source,
				ipv4: range.ipv4,
				ipv6: range.ipv6,
			})),
		},
		null,
		"\t",
	)}\n`,
);

console.log(
	`rules ${hash}: ${rules.tokens.length} tokens, ${ranges.length} IP range sources`,
);
