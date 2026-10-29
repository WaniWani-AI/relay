import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dist = new URL("../dist/index.js", import.meta.url);

const script = `
const realProcess = globalThis.process;
Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
const result = { process: typeof process };
try {
	const relay = await import(${JSON.stringify(dist.href)});
	const posted = [];
	globalThis.fetch = async (url, init) => {
		posted.push(JSON.parse(init.body).requests[0].userAgent);
		return new Response(null, { status: 202 });
	};
	const request = new Request("https://example.com/", { headers: { "user-agent": "Claude-User/1.0" } });
	result.isAgent = relay.isAgent(request);
	const pending = [];
	relay.recordAgentVisit(request, {
		apiUrl: "https://relay.test",
		key: "wwt_tok.b3Jn",
		waitUntil: (promise) => pending.push(promise),
	});
	await Promise.all(pending);
	result.posted = posted;
} catch (error) {
	result.error = String(error);
}
Object.defineProperty(globalThis, "process", { value: realProcess, configurable: true, writable: true });
console.log(JSON.stringify(result));
`;

describe("a runtime without process, such as a Cloudflare Worker", () => {
	it("loads the built module and records a visit", () => {
		expect(existsSync(dist), "run `bun run build` before the tests").toBe(true);
		const output = execFileSync(process.execPath, [
			"--input-type=module",
			"-e",
			script,
		]).toString();
		expect(JSON.parse(output)).toEqual({
			process: "undefined",
			isAgent: true,
			posted: ["Claude-User/1.0"],
		});
	});
});
