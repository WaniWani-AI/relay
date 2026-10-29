// Writes src/logic/ip-ranges.generated.json from the IP range files that AI
// vendors publish for their bots. Lists that also hold classic search crawlers
// (Google, Bing, Applebot) stay out, because those visits are not agent traffic.
// Run with `bun run rules`, review the diff, commit the JSON.

import { readFile, writeFile } from "node:fs/promises";

const SOURCES = [
	{ vendor: "openai", bot: "GPTBot", url: "https://openai.com/gptbot.json" },
	{
		vendor: "openai",
		bot: "OAI-SearchBot",
		url: "https://openai.com/searchbot.json",
	},
	{
		vendor: "openai",
		bot: "ChatGPT-User",
		url: "https://openai.com/chatgpt-user.json",
	},
	{
		vendor: "perplexity",
		bot: "PerplexityBot",
		url: "https://www.perplexity.com/perplexitybot.json",
	},
	{
		vendor: "perplexity",
		bot: "Perplexity-User",
		url: "https://www.perplexity.com/perplexity-user.json",
	},
	{
		vendor: "mistral",
		bot: "MistralAI-User",
		url: "https://mistral.ai/mistralai-user-ips.json",
	},
	{
		vendor: "commoncrawl",
		bot: "CCBot",
		url: "https://index.commoncrawl.org/ccbot.json",
	},
	{
		vendor: "duckduckgo",
		bot: "DuckAssistBot",
		url: "https://duckduckgo.com/duckassistbot.json",
	},
];

const OUTPUT = new URL(
	"../src/logic/ip-ranges.generated.json",
	import.meta.url,
);

type Prefix = { ipv4Prefix?: unknown; ipv6Prefix?: unknown };
type SourceRanges = {
	bot: string;
	url: string;
	ipv4: string[];
	ipv6: string[];
};

const isPrefixList = (value: unknown): value is { prefixes: Prefix[] } =>
	typeof value === "object" &&
	value !== null &&
	"prefixes" in value &&
	Array.isArray(value.prefixes);

const isSourceRanges = (value: unknown): value is SourceRanges =>
	typeof value === "object" &&
	value !== null &&
	"url" in value &&
	"ipv4" in value &&
	"ipv6" in value &&
	Array.isArray(value.ipv4) &&
	Array.isArray(value.ipv6);

const IPV4_CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const IPV6_CIDR = /^[0-9a-f:]+\/\d{1,3}$/i;

const sortCidrs = (values: Iterable<string>) =>
	[...new Set(values)].sort((a, b) =>
		a.localeCompare(b, "en", { numeric: true }),
	);

async function readPrevious(): Promise<Map<string, SourceRanges>> {
	try {
		const previous: unknown = JSON.parse(await readFile(OUTPUT, "utf8"));
		const sources =
			typeof previous === "object" && previous !== null && "sources" in previous
				? previous.sources
				: [];
		return new Map(
			(Array.isArray(sources) ? sources : [])
				.filter(isSourceRanges)
				.map((source) => [source.url, source]),
		);
	} catch {
		return new Map();
	}
}

async function fetchRanges(bot: string, url: string): Promise<SourceRanges> {
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		throw new Error(`status ${response.status}`);
	}
	const body: unknown = await response.json();
	if (!isPrefixList(body)) {
		throw new Error("no prefixes array");
	}
	const ipv4: string[] = [];
	const ipv6: string[] = [];
	for (const prefix of body.prefixes) {
		if (
			typeof prefix.ipv4Prefix === "string" &&
			IPV4_CIDR.test(prefix.ipv4Prefix)
		) {
			ipv4.push(prefix.ipv4Prefix);
		}
		if (
			typeof prefix.ipv6Prefix === "string" &&
			IPV6_CIDR.test(prefix.ipv6Prefix)
		) {
			ipv6.push(prefix.ipv6Prefix.toLowerCase());
		}
	}
	if (ipv4.length + ipv6.length === 0) {
		throw new Error("empty prefix list");
	}
	return { bot, url, ipv4: sortCidrs(ipv4), ipv6: sortCidrs(ipv6) };
}

const previous = await readPrevious();
const results: SourceRanges[] = [];
let failures = 0;

for (const source of SOURCES) {
	try {
		const ranges = await fetchRanges(source.bot, source.url);
		results.push(ranges);
		console.log(
			`ok     ${source.bot.padEnd(16)} ${ranges.ipv4.length + ranges.ipv6.length} prefixes`,
		);
	} catch (error) {
		failures++;
		const reason = error instanceof Error ? error.message : String(error);
		const kept = previous.get(source.url);
		if (kept) {
			results.push(kept);
		}
		console.log(
			`FAILED ${source.bot.padEnd(16)} ${source.url}: ${reason} (${kept ? "kept the previous ranges" : "no previous ranges"})`,
		);
	}
}

await writeFile(
	OUTPUT,
	`${JSON.stringify({ sources: results }, null, "\t")}\n`,
);

if (failures > 0) {
	process.exitCode = 1;
}
