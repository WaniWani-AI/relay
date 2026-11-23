// Writes fixtures/*.json from the TypeScript relay. Every port of the relay must give
// the same output for each case. `bun run fixtures` runs it, and CI fails when the
// committed fixtures differ from a new run.

import { mkdir, writeFile } from "node:fs/promises";
import {
	matchesPath,
	normalizePath,
	pageFormat,
	parseSiteRules,
	prefersMarkdown,
} from "../src/agent-page";
import { resolveClientIp } from "../src/client-ip";
import { readCappedHeaders } from "../src/headers";
import { recordAgentVisit, serveAgentPage } from "../src/index";
import { readKey } from "../src/key";
import agents from "../src/logic/agents.generated.json";
import { decide } from "../src/logic/decide";
import ranges from "../src/logic/ip-ranges.generated.json";
import { deriveMatchKey } from "../src/match-key";
import { RELAY_VERSION } from "../src/version";

const OUT = new URL("../fixtures/", import.meta.url);

console.warn = () => {};
delete process.env.WANIWANI_AGENT_TRAFFIC_KEY;

function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rand = random(20261123);
const pick = <T>(items: readonly T[]): T =>
	items[Math.floor(rand() * items.length)] as T;

function headerPairs(headers: Headers): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	headers.forEach((value, name) => {
		pairs.push([name, value]);
	});
	return pairs;
}

async function write(name: string, cases: unknown[]) {
	await writeFile(
		new URL(`${name}.json`, OUT),
		`${JSON.stringify({ relayVersion: RELAY_VERSION, cases }, null, "\t")}\n`,
	);
	console.log(`fixtures/${name}.json: ${cases.length} cases`);
}

const BROWSERS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
	"Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
	"curl/8.11.0",
	"",
];

function mixCase(text: string): string {
	return Array.from(text, (char) =>
		rand() < 0.5 ? char.toUpperCase() : char,
	).join("");
}

function ipv4ToInt(ip: string): number {
	return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function intToIpv4(value: number): string {
	return [24, 16, 8, 0]
		.map((shift) => Math.floor(value / 2 ** shift) % 256)
		.join(".");
}

function ipv4Edges(cidr: string): string[] {
	const [address = "", prefixText = "32"] = cidr.split("/");
	const prefix = Number(prefixText);
	const size = 2 ** (32 - prefix);
	const start = Math.floor(ipv4ToInt(address) / size) * size;
	const end = start + size - 1;
	const out = [intToIpv4(start), intToIpv4(end)];
	if (start > 0) {
		out.push(intToIpv4(start - 1));
	}
	if (end < 2 ** 32 - 1) {
		out.push(intToIpv4(end + 1));
	}
	return out;
}

function ipv6ToBigInt(ip: string): bigint {
	const [head = "", tail] = ip.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = tail === undefined || tail === "" ? [] : tail.split(":");
	const fill =
		tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
	return [...left, ...fill, ...right].reduce(
		(sum, group) => (sum << 16n) + BigInt(Number.parseInt(group, 16)),
		0n,
	);
}

function bigIntToIpv6(value: bigint): string {
	const groups: string[] = [];
	for (let shift = 112n; shift >= 0n; shift -= 16n) {
		groups.push(((value >> shift) & 0xffffn).toString(16));
	}
	return groups.join(":");
}

function ipv6Edges(cidr: string): string[] {
	const [address = "", prefixText = "128"] = cidr.split("/");
	const hostBits = 128n - BigInt(prefixText);
	const start = (ipv6ToBigInt(address) >> hostBits) << hostBits;
	const end = start + (1n << hostBits) - 1n;
	return [start, end, start - 1n, end + 1n]
		.filter((value) => value >= 0n && value < 1n << 128n)
		.map(bigIntToIpv6);
}

function decideCase(headers: Record<string, string>, ip: string | null) {
	let expected: boolean;
	try {
		expected = decide({
			headers: readCappedHeaders(new Headers(headers)),
			ip,
			useBundled: true,
		});
	} catch {
		expected = false;
	}
	return { headers, ip, expected };
}

function decideCases() {
	const cases = [];
	for (const token of agents.tokens) {
		cases.push(
			decideCase(
				{ "user-agent": `Mozilla/5.0 (compatible; ${mixCase(token)}/1.0)` },
				null,
			),
		);
		const padding = "x".repeat(1024 - Math.floor(token.length / 2));
		cases.push(decideCase({ "user-agent": `${padding}${token}` }, null));
		cases.push(
			decideCase(
				{ "user-agent": `${"y".repeat(1024 - token.length)}${token}` },
				null,
			),
		);
		cases.push(decideCase({ "user-agent": token.slice(0, -1) }, null));
	}
	for (const browser of BROWSERS) {
		cases.push(decideCase({ "user-agent": browser }, null));
	}
	cases.push(decideCase({}, null));
	const fragments = [
		...agents.tokens.map((token) => token.slice(0, 4)),
		"bot",
		"gpt",
		"user",
		"-",
		"/",
		" ",
		"1.0",
		"Mozilla",
	];
	for (let index = 0; index < 400; index++) {
		const parts = Array.from({ length: 1 + Math.floor(rand() * 8) }, () =>
			pick(fragments),
		);
		cases.push(decideCase({ "user-agent": mixCase(parts.join("")) }, null));
	}
	cases.push(decideCase({ "user-agent": "Café ÉCLAIR ClaudeBot" }, null));
	cases.push(decideCase({ "user-agent": "ÀÉÎÕÜ" }, null));
	cases.push(decideCase({ "signature-agent": '"https://chatgpt.com"' }, null));
	cases.push(decideCase({ "signature-agent": "" }, null));
	cases.push(decideCase({ dpop: "eyJ0eXAiOiJkcG9wK2p3dCJ9" }, null));
	for (const authorization of [
		"DPoP abc",
		"dpop abc",
		"DPOP  abc",
		"DPoP",
		"Bearer abc",
		"Basic",
		"Unknown abc",
		"NTLM TlRMTVNTUAAB",
		"dpopx abc",
	]) {
		cases.push(decideCase({ authorization }, null));
	}
	for (const source of ranges.sources) {
		for (const cidr of source.ipv4.slice(0, 6)) {
			for (const ip of ipv4Edges(cidr)) {
				cases.push(decideCase({ "user-agent": BROWSERS[0] ?? "" }, ip));
			}
		}
		for (const cidr of source.ipv6.slice(0, 6)) {
			for (const ip of ipv6Edges(cidr)) {
				cases.push(decideCase({}, ip));
			}
		}
	}
	const firstRange = ranges.sources[0]?.ipv4[0] ?? "0.0.0.0/32";
	const inside = ipv4Edges(firstRange)[0] ?? "0.0.0.0";
	for (const ip of [
		`::ffff:${inside}`,
		"::ffff:192.0.2.1",
		"192.0.2.1",
		"2001:db8::1",
		"::1",
		"127.0.0.1",
		"0.0.0.0",
		"255.255.255.255",
	]) {
		cases.push(decideCase({}, ip));
	}
	for (const ip of [
		"",
		"not-an-ip",
		"1.2.3",
		"1.2.3.4.5",
		"300.1.1.1",
		"::ffff:zz",
		"1.2.3.4:80",
	]) {
		cases.push(decideCase({}, ip));
	}
	return cases;
}

function headerCases() {
	const inputs: Array<Record<string, string>> = [
		{
			"user-agent": "ChatGPT-User/1.0",
			referer: "https://chatgpt.com/",
			cookie: "a=1",
			"x-forwarded-for": "1.2.3.4",
		},
		{ authorization: "Bearer secret-token" },
		{ authorization: "bearer secret-token" },
		{ authorization: "Bearer" },
		{ authorization: "Custom secret" },
		{ authorization: "SCRAM-SHA-256 abc" },
		{ authorization: "aws4-hmac-sha256 Credential=x" },
		{
			"Sec-CH-UA": '"Chromium";v="142"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Windows"',
		},
		{
			"signature-input": 'sig1=("@authority")',
			signature: "sig1=:abc:",
			from: "bot@example.com",
			"accept-language": "fr-FR",
		},
		{
			accept: "text/markdown",
			"x-waniwani-render": "1",
			host: "www.example.com",
		},
		{},
	];
	return inputs.map((headers) => ({
		headers,
		expected: readCappedHeaders(new Headers(headers)),
	}));
}

function clientIpCases() {
	const trusted = ["203.0.113.0/24", "198.51.100.7", "2001:db8:ffff::/48"];
	const inputs: Array<{
		remoteAddress: string;
		headers: Record<string, string>;
		clientIpHeader: string | null;
		trustedProxies: string[];
	}> = [
		{
			remoteAddress: "192.0.2.10",
			headers: {},
			clientIpHeader: null,
			trustedProxies: [],
		},
		{
			remoteAddress: " 192.0.2.10 ",
			headers: { "x-forwarded-for": "1.1.1.1" },
			clientIpHeader: null,
			trustedProxies: trusted,
		},
		{
			remoteAddress: "2001:DB8::1",
			headers: {},
			clientIpHeader: null,
			trustedProxies: [],
		},
		{
			remoteAddress: "192.0.2.10",
			headers: { "x-forwarded-for": "1.1.1.1" },
			clientIpHeader: "X-Forwarded-For",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "1.1.1.1" },
			clientIpHeader: "X-Forwarded-For",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1, 198.51.100.7" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "unknown, 1.1.1.1" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "1.1.1.1, unknown" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: {},
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-ogo-client-ip": " 1.1.1.1 " },
			clientIpHeader: "X-OGO-Client-IP",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "1.1.1.1:5555" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "[2001:DB8::5]:443" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "2001:db8::5, 2001:db8:ffff::1" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "2001:db8:ffff::9",
			headers: { "x-forwarded-for": "8.8.8.8" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "::ffff:203.0.113.5",
			headers: { "x-forwarded-for": "8.8.8.8" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "::ffff:8.8.8.8" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "8.8.8.8,,1.1.1.1" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "8.8.8.8" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: [],
		},
		{
			remoteAddress: "not-an-ip",
			headers: {},
			clientIpHeader: null,
			trustedProxies: [],
		},
		{
			remoteAddress: "",
			headers: {},
			clientIpHeader: null,
			trustedProxies: [],
		},
		{
			remoteAddress: "198.51.100.7",
			headers: { "x-forwarded-for": "8.8.4.4" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "198.51.100.8",
			headers: { "x-forwarded-for": "8.8.4.4" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: trusted,
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "8.8.4.4" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: ["0.0.0.0/0"],
		},
		{
			remoteAddress: "203.0.113.5",
			headers: { "x-forwarded-for": "1.1.1.1 , 2.2.2.2" },
			clientIpHeader: "x-forwarded-for",
			trustedProxies: ["203.0.113.0/24", "2.2.2.2/32"],
		},
	];
	return inputs.map((input) => ({
		...input,
		expected: resolveClientIp(input),
	}));
}

async function matchKeyCases() {
	const orgKeys = [
		"n2qibGz_0noxBqbFYI_P3xY0WiWLqVmTyKMczeYJ9oA",
		"b3JnLWtleS1zZWNyZXQ",
		"a",
		"b3Jn==",
		"Zm9v-_bar=",
	];
	const ips = [
		"198.51.100.23",
		"203.0.113.10",
		"2001:db8::1",
		"::ffff:192.0.2.1",
		"0.0.0.0",
		"fe80::1",
	];
	const cases = [];
	for (const orgKey of orgKeys) {
		for (const ip of ips) {
			cases.push({ orgKey, ip, expected: await deriveMatchKey(orgKey, ip) });
		}
	}
	return cases;
}

function keyCases() {
	const inputs = [
		"wwt_tok-EN_123.b3JnLWtleS1zZWNyZXQ",
		"  wwt_tok.b3Jn==  ",
		"wwt_tok.b3Jn===",
		"wwt_tok.",
		"wwt_.abc",
		"wwt_tok.abc.def",
		"wwx_tok.abc",
		"WWT_tok.abc",
		"wwt_t o k.abc",
		"wwt_tok.a+b",
		"",
		"   ",
	];
	return inputs.map((key) => ({ key, expected: readKey(key) }));
}

function acceptCases() {
	const handmade = [
		"",
		"*/*",
		"text/markdown",
		"text/html",
		"text/markdown, text/html",
		"text/html, text/markdown",
		"text/html;q=0.9, text/markdown",
		"text/markdown;q=0.5, text/html",
		"text/markdown;q=0.5, text/*;q=0.4",
		"text/markdown;q=0.5, */*;q=0.6",
		"text/markdown;q=0",
		"text/markdown; q=0.000",
		"TEXT/MARKDOWN",
		"text/markdown;Q=0.5, text/html;q=0.5",
		"text/markdown;q=abc",
		"text/markdown;q=",
		"text/markdown;q",
		"text/markdown;q=0x1",
		"text/markdown;q=1e0, text/html;q=1",
		"text/markdown;q=.5, text/html;q=0.4",
		"text/markdown;q=5., text/html",
		"text/markdown;q=+0.7, text/html;q=0.7",
		"text/markdown;q=-1",
		"text/markdown;q=Infinity",
		"text/markdown;q= 0.8 , text/html;q=0.8",
		"text/markdown;q=0.8=9",
		"text/markdown;charset=utf-8;q=0.8, text/html;level=1;q=0.9",
		"text/markdown, text/markdown;q=0",
		"text/markdown;q=0, text/markdown;q=0.3",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"application/json, text/plain, */*",
		"text/plain;q=1, text/markdown;q=1",
		" text/markdown ",
		",,text/markdown,,",
		"text/x-markdown",
		"text/*",
		"text/markdown;q=1;q=0",
		"text/markdown;q=0.5;level=2",
	];
	const pieces = [
		"text/markdown",
		"text/html",
		"text/*",
		"*/*",
		"application/json",
		"text/plain",
	];
	const qs = [
		"",
		";q=0",
		";q=0.1",
		";q=0.5",
		";q=0.9",
		";q=1",
		";q=1.0",
		";q=0.50",
	];
	const generated = Array.from({ length: 300 }, () =>
		Array.from(
			{ length: 1 + Math.floor(rand() * 4) },
			() => `${pick(pieces)}${pick(qs)}`,
		).join(pick([", ", ",", " , "])),
	);
	return [...handmade, ...generated].map((accept) => ({
		accept,
		pageFormat: pageFormat(accept),
		prefersMarkdown: prefersMarkdown(accept),
	}));
}

function pathCases() {
	const normalize = [
		"/",
		"",
		"/pricing",
		"/pricing/",
		"/pricing///",
		"///",
		"/a/b/",
		"/A/B",
	].map((path) => ({
		path,
		expected: normalizePath(path),
	}));
	const patterns = [
		["/pricing"],
		["/pricing/"],
		["/products/*"],
		["/products/*/"],
		["*"],
		["/*"],
		["/"],
		["/a", "/b/*"],
		[],
		["/Pricing"],
		["products/*"],
		["/products*"],
	];
	const paths = [
		"/",
		"/pricing",
		"/pricing/x",
		"/products",
		"/products/a",
		"/products/a/b",
		"/productsx",
		"/a",
		"/b",
		"/b/c",
		"/Pricing",
	];
	const matches = [];
	for (const list of patterns) {
		for (const path of paths) {
			matches.push({ path, patterns: list, expected: matchesPath(path, list) });
		}
	}
	return { normalize, matches };
}

const VALID_SITE_RULES = {
	version: 1,
	pagesUrl: "https://pages.test/serve/tok/pages",
	userAgentTokens: ["chatgpt-user", "claude-user"],
	deadlines: { headersMs: 50, bodyMs: 50 },
	maxBodyBytes: 1000,
	sites: [
		{
			hostname: "www.example.com",
			agentPages: { enabled: true, paths: ["/pricing", "/products/*"] },
		},
	],
};

function siteRulesCases() {
	const variants: Array<[string, unknown]> = [
		["valid", VALID_SITE_RULES],
		[
			"ask deadline",
			{
				...VALID_SITE_RULES,
				deadlines: { headersMs: 50, bodyMs: 50, askMs: 900 },
			},
		],
		[
			"ask deadline zero",
			{
				...VALID_SITE_RULES,
				deadlines: { headersMs: 50, bodyMs: 50, askMs: 0 },
			},
		],
		[
			"ask deadline text",
			{
				...VALID_SITE_RULES,
				deadlines: { headersMs: 50, bodyMs: 50, askMs: "900" },
			},
		],
		[
			"fractional deadlines",
			{ ...VALID_SITE_RULES, deadlines: { headersMs: 0.5, bodyMs: 1.5 } },
		],
		[
			"zero headers deadline",
			{ ...VALID_SITE_RULES, deadlines: { headersMs: 0, bodyMs: 50 } },
		],
		[
			"negative body deadline",
			{ ...VALID_SITE_RULES, deadlines: { headersMs: 50, bodyMs: -1 } },
		],
		[
			"deadline as text",
			{ ...VALID_SITE_RULES, deadlines: { headersMs: "50", bodyMs: 50 } },
		],
		["no deadlines", { ...VALID_SITE_RULES, deadlines: null }],
		["huge max body", { ...VALID_SITE_RULES, maxBodyBytes: 1e300 }],
		["zero max body", { ...VALID_SITE_RULES, maxBodyBytes: 0 }],
		["version 2", { ...VALID_SITE_RULES, version: 2 }],
		["version as text", { ...VALID_SITE_RULES, version: "1" }],
		[
			"pages url slashes",
			{ ...VALID_SITE_RULES, pagesUrl: "https://pages.test/x///" },
		],
		["pages url missing", { ...VALID_SITE_RULES, pagesUrl: undefined }],
		[
			"tokens cleaned",
			{
				...VALID_SITE_RULES,
				userAgentTokens: [" ChatGPT-User ", "", "  ", "CLAUDE"],
			},
		],
		["tokens not strings", { ...VALID_SITE_RULES, userAgentTokens: ["a", 1] }],
		["sites missing", { ...VALID_SITE_RULES, sites: undefined }],
		["sites empty", { ...VALID_SITE_RULES, sites: [] }],
		[
			"site hostname upper",
			{
				...VALID_SITE_RULES,
				sites: [
					{
						hostname: "WWW.Example.COM",
						blockedUserAgentTokens: [" GPTBot ", ""],
						agentPages: { enabled: false, paths: [] },
					},
				],
			},
		],
		[
			"site blocked null",
			{
				...VALID_SITE_RULES,
				sites: [
					{
						hostname: "a.test",
						blockedUserAgentTokens: null,
						agentPages: { enabled: true, paths: ["*"] },
					},
				],
			},
		],
		[
			"site blocked wrong",
			{
				...VALID_SITE_RULES,
				sites: [
					{
						hostname: "a.test",
						blockedUserAgentTokens: "x",
						agentPages: { enabled: true, paths: ["*"] },
					},
				],
			},
		],
		[
			"site enabled text",
			{
				...VALID_SITE_RULES,
				sites: [
					{ hostname: "a.test", agentPages: { enabled: "true", paths: ["*"] } },
				],
			},
		],
		[
			"site paths missing",
			{
				...VALID_SITE_RULES,
				sites: [{ hostname: "a.test", agentPages: { enabled: true } }],
			},
		],
		["site not object", { ...VALID_SITE_RULES, sites: ["a.test"] }],
		[
			"extra fields",
			{
				...VALID_SITE_RULES,
				extra: true,
				sites: [
					{
						hostname: "a.test",
						extra: 1,
						agentPages: { enabled: true, paths: ["/x"], extra: 2 },
					},
				],
			},
		],
		["null", null],
		["array", []],
		["text", "rules"],
	];
	return variants.map(([name, input]) => ({
		name,
		input,
		expected: parseSiteRules(input),
	}));
}

type FakeAnswer = {
	status: number;
	headers?: Record<string, string>;
	body?: string;
	headerDelayMs?: number;
	bodyDelayMs?: number;
};

type ServeCase = {
	name: string;
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		ip?: string;
		body?: string;
	};
	siteRules: FakeAnswer;
	pageService: FakeAnswer | null;
};

const PAGES = "https://pages.test/serve/tok/pages";

const rulesAnswer = (
	overrides: Record<string, unknown> = {},
	siteOverrides: Record<string, unknown> = {},
): FakeAnswer => ({
	status: 200,
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		success: true,
		data: {
			...VALID_SITE_RULES,
			pagesUrl: PAGES,
			maxBodyBytes: 64,
			sites: [
				{
					hostname: "www.example.com",
					blockedUserAgentTokens: ["gptbot"],
					agentPages: {
						enabled: true,
						paths: ["/", "/pricing", "/products/*", "/ask", "/openapi.json"],
					},
					...siteOverrides,
				},
			],
			...overrides,
		},
	}),
});

const markdown = (
	body = "# Pricing",
	extra: Partial<FakeAnswer> = {},
): FakeAnswer => ({
	status: 200,
	headers: { "content-type": "text/markdown; charset=utf-8" },
	body,
	...extra,
});

const CHATGPT =
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const BROWSER = BROWSERS[0] ?? "";

const get = (
	url: string,
	headers: Record<string, string> = {},
	extra: Partial<ServeCase["request"]> = {},
) => ({
	method: "GET",
	url,
	headers: { "user-agent": CHATGPT, ...headers },
	...extra,
});

function serveScenarios(): ServeCase[] {
	const host = "https://www.example.com";
	return [
		{
			name: "agent gets the page",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "agent asks for markdown",
			request: get(`${host}/pricing`, { accept: "text/markdown" }),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "agent asks for html",
			request: get(`${host}/pricing`, { accept: "text/html" }),
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: "<h1>Pricing</h1>",
			},
		},
		{
			name: "home page has no trailing slash",
			request: get(`${host}/`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Home"),
		},
		{
			name: "trailing slash is dropped",
			request: get(`${host}/pricing/`),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "query is forwarded",
			request: get(`${host}/products/car?model=a%20b&x=1`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Car"),
		},
		{
			name: "folder pattern covers the folder",
			request: get(`${host}/products`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Products"),
		},
		{
			name: "path not listed",
			request: get(`${host}/contact`),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "host not listed",
			request: get("https://other.example.com/pricing"),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "host upper case",
			request: get("https://WWW.EXAMPLE.COM/pricing"),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "host with port",
			request: get("https://www.example.com:8443/pricing"),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "agent pages off",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(
				{},
				{ agentPages: { enabled: false, paths: ["*"] } },
			),
			pageService: markdown(),
		},
		{
			name: "person browser",
			request: get(`${host}/pricing`, {
				"user-agent": BROWSER,
				accept: "text/html,*/*;q=0.8",
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "person prefers markdown",
			request: get(`${host}/pricing`, {
				"user-agent": BROWSER,
				accept: "text/markdown, text/html;q=0.9",
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "crawler that is not a user agent token",
			request: get(`${host}/pricing`, {
				"user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "crawler that prefers markdown",
			request: get(`${host}/pricing`, {
				"user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
				accept: "text/markdown",
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "agent by ip only",
			request: get(
				`${host}/pricing`,
				{ "user-agent": BROWSER },
				{ ip: ipv4Edges(ranges.sources[0]?.ipv4[0] ?? "0.0.0.0/32")[0] ?? "" },
			),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "agent by signature only",
			request: get(`${host}/pricing`, {
				"user-agent": BROWSER,
				"signature-agent": '"https://chatgpt.com"',
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "blocked agent",
			request: get(`${host}/pricing`, {
				"user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)",
			}),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "blocked agent on a path without pages",
			request: get(`${host}/contact`, { "user-agent": "GPTBot/1.2" }),
			siteRules: rulesAnswer(),
			pageService: null,
		},
		{
			name: "blocked agent head",
			request: {
				...get(`${host}/pricing`, { "user-agent": "GPTBot/1.2" }),
				method: "HEAD",
			},
			siteRules: rulesAnswer(),
			pageService: null,
		},
		{
			name: "browser string with a blocked token",
			request: get(`${host}/pricing`, { "user-agent": `${BROWSER} gptbot` }),
			siteRules: rulesAnswer(),
			pageService: null,
		},
		{
			name: "head gets headers only",
			request: { ...get(`${host}/pricing`), method: "HEAD" },
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "lowercase method",
			request: { ...get(`${host}/pricing`), method: "get" },
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "post to a page",
			request: { ...get(`${host}/pricing`), method: "POST", body: "{}" },
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "render request",
			request: get(`${host}/pricing`, { "x-waniwani-render": "1" }),
			siteRules: rulesAnswer(),
			pageService: markdown(),
		},
		{
			name: "render request from a blocked agent",
			request: get(`${host}/pricing`, {
				"user-agent": "GPTBot",
				"x-waniwani-render": "1",
			}),
			siteRules: rulesAnswer(),
			pageService: null,
		},
		{
			name: "page service 404",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: { status: 404 },
		},
		{
			name: "page service 500",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: { status: 500, body: "boom" },
		},
		{
			name: "page service redirect",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: { status: 301, headers: { location: "/x" } },
		},
		{
			name: "page service pdf",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/pdf" },
				body: "%PDF",
			},
		},
		{
			name: "page service no content type",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: { status: 200, body: "# x" },
		},
		{
			name: "page service json on a page",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "page service json on a json path",
			request: get(`${host}/openapi.json`, { accept: "application/json" }),
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json; charset=utf-8" },
				body: '{"openapi":"3.1.0"}',
			},
		},
		{
			name: "page over the size cap",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: markdown("x".repeat(65)),
		},
		{
			name: "page at the size cap",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: markdown("x".repeat(64)),
		},
		{
			name: "page service headers too slow",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Pricing", { headerDelayMs: 300 }),
		},
		{
			name: "page service body too slow",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Pricing", { bodyDelayMs: 300 }),
		},
		{
			name: "page service unreachable",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: null,
		},
		{
			name: "site rules 500",
			request: get(`${host}/pricing`),
			siteRules: { status: 500 },
			pageService: markdown(),
		},
		{
			name: "site rules malformed",
			request: get(`${host}/pricing`),
			siteRules: {
				status: 200,
				body: JSON.stringify({ data: { version: 2 } }),
			},
			pageService: markdown(),
		},
		{
			name: "site rules too slow",
			request: get(`${host}/pricing`),
			siteRules: { ...rulesAnswer(), headerDelayMs: 600 },
			pageService: markdown(),
		},
		{
			name: "ask post",
			request: {
				...get(`${host}/ask`, { "content-type": "application/json" }),
				method: "POST",
				body: '{"q":"price?"}',
			},
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"answer":"42"}',
			},
		},
		{
			name: "ask post with trailing slash",
			request: { ...get(`${host}/ask/`), method: "POST", body: '{"q":"x"}' },
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "ask post rate limited",
			request: { ...get(`${host}/ask`), method: "POST", body: '{"q":"x"}' },
			siteRules: rulesAnswer(),
			pageService: {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "30" },
				body: '{"error":"slow down"}',
			},
		},
		{
			name: "ask post rate limited without body",
			request: { ...get(`${host}/ask`), method: "POST", body: '{"q":"x"}' },
			siteRules: rulesAnswer(),
			pageService: { status: 429, headers: { "retry-after": "5" } },
		},
		{
			name: "ask post empty body",
			request: { ...get(`${host}/ask`), method: "POST", body: "" },
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "ask post body at the cap",
			request: {
				...get(`${host}/ask`),
				method: "POST",
				body: "x".repeat(16384),
			},
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "ask post body over the cap",
			request: {
				...get(`${host}/ask`),
				method: "POST",
				body: "x".repeat(16385),
			},
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "ask post with a large content length",
			request: {
				...get(`${host}/ask`, { "content-length": "20000" }),
				method: "POST",
				body: "{}",
			},
			siteRules: rulesAnswer(),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		},
		{
			name: "ask get",
			request: get(`${host}/ask`),
			siteRules: rulesAnswer(),
			pageService: markdown("# Ask"),
		},
		{
			name: "ask post 429 on a page path is null",
			request: get(`${host}/pricing`),
			siteRules: rulesAnswer(),
			pageService: { status: 429, headers: { "retry-after": "5" } },
		},
		{
			name: "ask post slower than headers but within ask deadline",
			request: { ...get(`${host}/ask`), method: "POST", body: "{}" },
			siteRules: rulesAnswer({
				deadlines: { headersMs: 50, bodyMs: 200, askMs: 600 },
			}),
			pageService: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
				headerDelayMs: 150,
			},
		},
	];
}

async function readFake(
	answer: FakeAnswer,
	signal: AbortSignal | null | undefined,
): Promise<Response> {
	const wait = (ms: number) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new DOMException("aborted", "AbortError"));
			});
		});
	if (answer.headerDelayMs) {
		await wait(answer.headerDelayMs);
	}
	const encoder = new TextEncoder();
	const text = answer.body;
	const body =
		text === undefined
			? null
			: new ReadableStream<Uint8Array>({
					async start(controller) {
						if (answer.bodyDelayMs) {
							await new Promise((resolve) =>
								setTimeout(resolve, answer.bodyDelayMs),
							);
						}
						try {
							controller.enqueue(encoder.encode(text));
							controller.close();
						} catch {}
					},
				});
	return new Response(body, {
		status: answer.status,
		headers: answer.headers ?? {},
	});
}

async function serveCases() {
	const realFetch = globalThis.fetch;
	const cases = [];
	let index = 0;
	for (const scenario of serveScenarios()) {
		index++;
		const ingestToken = `case${index}`;
		const apiUrl = "https://api.test";
		const rulesUrl = `${apiUrl}/api/v2/agent-traffic/serve/${ingestToken}/rules`;
		let pageRequest: {
			url: string;
			method: string;
			headers: Record<string, string>;
			body: string | null;
		} | null = null;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (url === rulesUrl) {
				return readFake(scenario.siteRules, init?.signal);
			}
			if (url.startsWith(PAGES)) {
				const headers = Object.fromEntries(
					headerPairs(new Headers(init?.headers)),
				);
				const body = init?.body
					? new TextDecoder().decode(init.body as Uint8Array)
					: null;
				pageRequest = { url, method: init?.method ?? "GET", headers, body };
				if (!scenario.pageService) {
					throw new TypeError("fetch failed");
				}
				return readFake(scenario.pageService, init?.signal);
			}
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		const headers: Record<string, string> = { ...scenario.request.headers };
		if (scenario.request.ip) {
			headers["cf-connecting-ip"] = scenario.request.ip;
		}
		const init: RequestInit = { method: scenario.request.method, headers };
		if (
			scenario.request.body !== undefined &&
			!["GET", "HEAD"].includes(scenario.request.method.toUpperCase())
		) {
			init.body = scenario.request.body;
		}
		const response = await serveAgentPage(
			new Request(scenario.request.url, init),
			{
				apiUrl,
				key: `wwt_${ingestToken}.b3JnLWtleQ`,
			},
		);
		const answer = response
			? {
					status: response.status,
					headers: Object.fromEntries(headerPairs(response.headers)),
					body: response.body ? await response.text() : null,
				}
			: null;
		cases.push({
			...scenario,
			apiUrl,
			ingestToken,
			expected: { answer, pageRequest },
		});
	}
	globalThis.fetch = realFetch;
	return cases;
}

type RecordScenario = {
	name: string;
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		ip?: string;
	};
	key?: string;
	omit?: string[];
};

function recordScenarios(): RecordScenario[] {
	const key = "wwt_rec.n2qibGz_0noxBqbFYI_P3xY0WiWLqVmTyKMczeYJ9oA";
	const base = {
		method: "GET",
		url: "https://www.example.com/pricing?x=1",
		headers: {
			"user-agent": CHATGPT,
			referer: "https://chatgpt.com/",
			accept: "text/html",
			cookie: "session=secret",
		},
		ip: "198.51.100.23",
	};
	return [
		{ name: "full record", request: base, key },
		{ name: "no key", request: base },
		{ name: "malformed key", request: base, key: "wwt_bad" },
		{ name: "no ip", request: { ...base, ip: undefined }, key },
		{ name: "ipv6", request: { ...base, ip: "2001:db8::1" }, key },
		{
			name: "authorization scheme only",
			request: {
				...base,
				headers: { ...base.headers, authorization: "Bearer secret" },
			},
			key,
		},
		{
			name: "unknown authorization scheme",
			request: {
				...base,
				headers: { ...base.headers, authorization: "Secret abc" },
			},
			key,
		},
		{ name: "omit match key", request: base, key, omit: ["matchKey"] },
		{ name: "omit user agent field", request: base, key, omit: ["userAgent"] },
		{
			name: "omit user agent header",
			request: base,
			key,
			omit: ["User-Agent"],
		},
		{ name: "omit referer", request: base, key, omit: ["referer"] },
		{ name: "omit accept", request: base, key, omit: ["ACCEPT"] },
		{ name: "post", request: { ...base, method: "POST" }, key },
		{ name: "head lowercase", request: { ...base, method: "head" }, key },
		{
			name: "root path",
			request: { ...base, url: "https://www.example.com/" },
			key,
		},
		{
			name: "port and upper host",
			request: { ...base, url: "https://WWW.Example.com:8443/a/b?c=d&e=%20f" },
			key,
		},
		{
			name: "no user agent",
			request: { ...base, headers: { accept: "*/*" } },
			key,
		},
		{
			name: "all capped headers",
			request: {
				...base,
				headers: {
					"user-agent": CHATGPT,
					referer: "r",
					accept: "a",
					"accept-language": "fr",
					from: "f@x",
					"signature-agent": "s",
					"signature-input": "si",
					signature: "sg",
					dpop: "d",
					"sec-ch-ua": "u",
					"sec-ch-ua-platform": "p",
					"sec-ch-ua-mobile": "?0",
					authorization: "DPoP t",
					"x-other": "o",
				},
			},
			key,
		},
	];
}

async function recordCases() {
	const realFetch = globalThis.fetch;
	const cases = [];
	for (const scenario of recordScenarios()) {
		const posted: { value: { url: string; body: unknown } | null } = {
			value: null,
		};
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			posted.value = { url, body: JSON.parse(String(init?.body)) };
			return new Response(null, { status: 202 });
		}) as typeof fetch;
		const headers: Record<string, string> = { ...scenario.request.headers };
		if (scenario.request.ip) {
			headers["cf-connecting-ip"] = scenario.request.ip;
		}
		const pending: Promise<unknown>[] = [];
		await recordAgentVisit(
			new Request(scenario.request.url, {
				method: scenario.request.method,
				headers,
			}),
			{
				apiUrl: "https://api.test",
				key: scenario.key ?? "",
				omit: scenario.omit,
				waitUntil: (work) => {
					pending.push(work);
				},
			},
		);
		await Promise.all(pending);
		let expected = null;
		const sent = posted.value;
		if (sent !== null) {
			const body = sent.body as { requests: Array<Record<string, unknown>> };
			const {
				occurredAt: _occurredAt,
				sourceEventId: _sourceEventId,
				uses: _uses,
				platform: _platform,
				...record
			} = body.requests[0] ?? {};
			expected = { url: sent.url, record };
		}
		cases.push({ ...scenario, apiUrl: "https://api.test", expected });
	}
	globalThis.fetch = realFetch;
	return cases;
}

await mkdir(OUT, { recursive: true });
await write("decide", decideCases());
await write("headers", headerCases());
await write("client-ip", clientIpCases());
await write("match-key", await matchKeyCases());
await write("key", keyCases());
await write("accept", acceptCases());
await write("paths", [pathCases()]);
await write("site-rules", siteRulesCases());
await write("record", await recordCases());
await write("serve", await serveCases());
process.exit(0);
