import { describe, expect, it } from "vitest";
import { type CloudFrontRequest, isAiReferral } from "../src/index";
import ranges from "../src/logic/ip-ranges.generated.json";

const BROWSER =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";

const agentIp = ranges.sources
	.flatMap((source) => source.ipv4)[0]
	?.split("/")[0];

const visit = (headers: Record<string, string>) =>
	isAiReferral(
		new Request("https://www.example.com/pricing", {
			headers: { "user-agent": BROWSER, ...headers },
		}),
		{ rules: "bundled" },
	);

describe("isAiReferral", () => {
	it.each([
		"https://chatgpt.com/",
		"https://chat.openai.com/c/1",
		"android-app://com.openai.chatgpt/",
		"https://claude.ai/chat/1",
		"https://www.perplexity.ai/search?q=a",
		"https://gemini.google.com/app",
		"https://copilot.microsoft.com/",
		"https://www.meta.ai/",
		"HTTPS://ChatGPT.COM/",
		" https://chatgpt.com/ ",
	])("matches a person sent from %s", (referer) => {
		expect(visit({ referer })).toBe(true);
	});

	it.each([
		"https://notchatgpt.com/",
		"https://chatgpt.com.example.net/",
		"https://www.google.com/",
		"ftp://chatgpt.com/",
		"chatgpt.com",
		"",
	])("does not match the referer %j", (referer) => {
		expect(visit({ referer })).toBe(false);
	});

	it("does not match a request without a referer", () => {
		expect(visit({})).toBe(false);
	});

	it("does not match an agent that sends an AI assistant referer", () => {
		expect(
			visit({
				"user-agent":
					"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
				referer: "https://chatgpt.com/",
			}),
		).toBe(false);
		expect(
			visit({ referer: "https://chatgpt.com/", "signature-agent": "x" }),
		).toBe(false);
	});

	it("does not match a request from an AI vendor IP range", () => {
		expect(agentIp).toBeDefined();
		expect(
			visit({
				referer: "https://chatgpt.com/",
				"cf-connecting-ip": agentIp ?? "",
			}),
		).toBe(false);
	});

	it("reads the referer of a CloudFront request", () => {
		const request: CloudFrontRequest = {
			clientIp: "198.51.100.23",
			method: "GET",
			uri: "/pricing",
			querystring: "",
			headers: {
				host: [{ value: "www.example.com" }],
				"user-agent": [{ value: BROWSER }],
				referer: [{ value: "android-app://com.openai.chatgpt/" }],
			},
		};
		expect(isAiReferral(request, { rules: "bundled" })).toBe(true);
	});

	const visitUrl = (query: string, headers: Record<string, string> = {}) =>
		isAiReferral(
			new Request(`https://www.example.com/pricing${query}`, {
				headers: { "user-agent": BROWSER, ...headers },
			}),
			{ rules: "bundled" },
		);

	it.each([
		"?utm_source=chatgpt.com",
		"?x=1&utm_source=chatgpt.com",
		"?utm_source=ChatGPT",
		"?utm_source=openai",
		"?utm_source=perplexity",
		"?utm_source=perplexity.ai",
		"?utm_source=claude.ai",
		"?utm_source=gemini",
		"?utm_source=geminiforbusiness",
		"?utm_source=l.metamuse.ai",
		"?utm_source=copilot",
		"?utm_source=chatgpt%2Ecom",
		"?utm_source=+chatgpt.com+",
	])("matches a person without a referer sent with %s", (query) => {
		expect(visitUrl(query)).toBe(true);
	});

	it.each([
		"",
		"?utm_source=",
		"?utm_source=google",
		"?utm_source=chatgpt.com.example.net",
		"?utm_source=notchatgpt.com",
		"?utm_source=metamuse.ai",
		"?utm_source=grok",
		"?utm_source=toString",
		"?utm_source=__proto__",
		"?utm_medium=chatgpt.com",
		"?utm_source=newsletter&utm_source=chatgpt.com",
	])("does not match the query %j", (query) => {
		expect(visitUrl(query)).toBe(false);
	});

	it("matches an AI utm_source behind a search engine referer", () => {
		expect(
			visitUrl("?utm_source=chatgpt.com", {
				referer: "https://www.google.com/",
			}),
		).toBe(true);
	});

	it("does not match an agent that follows a link with an AI utm_source", () => {
		expect(
			visitUrl("?utm_source=chatgpt.com", {
				"user-agent":
					"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
			}),
		).toBe(false);
	});

	it("reads the utm_source of a CloudFront request", () => {
		const request: CloudFrontRequest = {
			clientIp: "198.51.100.23",
			method: "GET",
			uri: "/pricing",
			querystring: "utm_source=chatgpt.com",
			headers: {
				host: [{ value: "www.example.com" }],
				"user-agent": [{ value: BROWSER }],
			},
		};
		expect(isAiReferral(request, { rules: "bundled" })).toBe(true);
	});
});
