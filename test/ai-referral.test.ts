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
});
