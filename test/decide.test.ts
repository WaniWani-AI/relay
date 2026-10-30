import { describe, expect, it } from "vitest";
import { decide } from "../src/logic";
import agents from "../src/logic/agents.generated.json";
import { isAgentIp } from "../src/logic/decide";
import ranges from "../src/logic/ip-ranges.generated.json";

const ua = (userAgent: string) =>
	decide({ headers: { "user-agent": userAgent }, ip: null });

describe("decide: user agent tokens", () => {
	it.each([
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
		"Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
		"CCBot/2.0 (https://commoncrawl.org/faq/)",
		"DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)",
		"Datenbank Crawler",
		"CLAUDE-USER",
	])("matches %s", (userAgent) => {
		expect(ua(userAgent)).toBe(true);
	});

	it.each([
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.6723.69 Safari/537.36",
		"Googlebot/2.1 (+http://www.google.com/bot.html)",
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
		"Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
		"DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
		"curl/8.7.1",
		"Wget/1.24.5",
		"python-requests/2.32.3",
		"Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
		"Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
		"Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
		"Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
		"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
		"",
	])("does not match %s", (userAgent) => {
		expect(ua(userAgent)).toBe(false);
	});

	it("keeps the token list lowercase and free of classic indexers", () => {
		for (const token of agents.tokens) {
			expect(token).toBe(token.toLowerCase());
		}
		for (const indexer of [
			"googlebot",
			"bingbot",
			"yandexbot",
			"duckduckbot",
			"baiduspider",
		]) {
			expect(agents.tokens).not.toContain(indexer);
		}
	});
});

describe("decide: headers", () => {
	it("matches on signature-agent alone", () => {
		expect(
			decide({
				headers: {
					"signature-agent": '"https://chatgpt.com"',
					"user-agent": "Mozilla/5.0 Chrome/130",
				},
				ip: null,
			}),
		).toBe(true);
	});

	it("matches on a dpop header", () => {
		expect(decide({ headers: { dpop: "eyJhbGciOi" }, ip: null })).toBe(true);
	});

	it("matches on the DPoP authorization scheme in any case", () => {
		expect(decide({ headers: { authorization: "DPoP" }, ip: null })).toBe(true);
		expect(decide({ headers: { authorization: "dpop" }, ip: null })).toBe(true);
		expect(decide({ headers: { authorization: "Bearer" }, ip: null })).toBe(
			false,
		);
	});
});

describe("decide: IP ranges", () => {
	const browser = {
		"user-agent": "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36",
	};
	const at = (ip: string | null) => decide({ headers: browser, ip });

	it("matches IPv4 addresses inside a published range", () => {
		expect(ranges.sources.flatMap((source) => source.ipv4)).toContain(
			"20.171.206.0/24",
		);
		expect(at("20.171.206.0")).toBe(true);
		expect(at("20.171.206.77")).toBe(true);
		expect(at("20.171.206.255")).toBe(true);
	});

	it("does not match IPv4 addresses just outside a range", () => {
		expect(at("20.171.205.255")).toBe(false);
		expect(at("20.171.208.0")).toBe(false);
		expect(at("8.8.8.8")).toBe(false);
		expect(at("203.0.113.9")).toBe(false);
	});

	it("matches IPv6 addresses inside a published range", () => {
		expect(ranges.sources.flatMap((source) => source.ipv6)).toContain(
			"2600:1f28:365:8000::/56",
		);
		expect(at("2600:1f28:365:80ab::1")).toBe(true);
		expect(at("2600:1f28:365:80ff:ffff:ffff:ffff:ffff")).toBe(true);
		expect(at("2600:1f28:365:8100::1")).toBe(false);
		expect(at("2001:db8::1")).toBe(false);
	});

	it("matches an IPv4-mapped IPv6 address against the IPv4 ranges", () => {
		expect(at("::ffff:20.171.206.77")).toBe(true);
		expect(at("::ffff:8.8.8.8")).toBe(false);
	});

	it("ignores garbage and missing addresses", () => {
		for (const ip of [
			null,
			"",
			"unknown",
			"999.1.1.1",
			"1.2.3",
			"::::",
			"gggg::1",
			"20.171.206.77:443",
		]) {
			expect(at(ip)).toBe(false);
		}
	});
});

describe("the published ranges", () => {
	it("match the network address of every range in the data file", () => {
		const cidrs = ranges.sources.flatMap((source) => [
			...source.ipv4,
			...source.ipv6,
		]);
		expect(cidrs.length).toBeGreaterThan(100);
		for (const cidr of cidrs) {
			expect(isAgentIp(cidr.split("/")[0] ?? ""), cidr).toBe(true);
		}
	});
});
