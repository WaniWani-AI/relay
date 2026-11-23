import { Agent, request } from "node:http";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		with: { type: "string", default: "http://127.0.0.1:8080" },
		without: { type: "string", default: "http://127.0.0.1:8082" },
		requests: { type: "string", default: "4000" },
		"max-added-ms": { type: "string", default: "2" },
	},
});

const BROWSER =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

function get(base: string, path: string): Promise<number> {
	const url = new URL(path, base);
	const started = performance.now();
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				agent,
				headers: {
					host: "www.e2e.test",
					"user-agent": BROWSER,
					accept: "text/html,*/*;q=0.8",
				},
			},
			(response) => {
				response.resume();
				response.on("end", () => resolve(performance.now() - started));
			},
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}

function percentile(values: number[], p: number) {
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[
			Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
		] ?? 0
	);
}

const total = Number(args.requests);
const on: number[] = [];
const off: number[] = [];
for (let index = 0; index < 200; index++) {
	await get(args.with, "/contact");
	await get(args.without, "/contact");
}
for (let index = 0; index < total; index++) {
	on.push(await get(args.with, "/contact"));
	off.push(await get(args.without, "/contact"));
}

const row = (name: string, values: number[]) =>
	`${name.padEnd(12)} p50 ${percentile(values, 50).toFixed(3)} ms  p99 ${percentile(values, 99).toFixed(3)} ms`;
console.log(row("module on", on));
console.log(row("module off", off));
const added = percentile(on, 99) - percentile(off, 99);
console.log(`added at p99: ${(added * 1000).toFixed(0)} µs`);
agent.destroy();
if (added > Number(args["max-added-ms"])) {
	console.log(
		`FAIL the module adds more than ${args["max-added-ms"]} ms at p99 for persons`,
	);
	process.exit(1);
}
console.log("PASS");
