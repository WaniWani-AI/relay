import { BlockList } from "node:net";
import agents from "./agents.json";
import ranges from "./ip-ranges.generated.json";

export type DecideInput = {
	headers: Record<string, string>;
	ip: string | null;
};

const MAX_SCANNED_USER_AGENT = 1024;
const PREFIX = 3;

const tokensByPrefix = new Map<string, string[]>();
for (const token of agents.tokens) {
	const key = token.slice(0, PREFIX);
	const list = tokensByPrefix.get(key);
	if (list) {
		list.push(token);
	} else {
		tokensByPrefix.set(key, [token]);
	}
}

const agentRanges = new BlockList();
const addRanges = (cidrs: string[], type: "ipv4" | "ipv6") => {
	for (const cidr of cidrs) {
		const [address = "", prefix] = cidr.split("/");
		agentRanges.addSubnet(address, Number(prefix), type);
	}
};
for (const source of ranges.sources) {
	addRanges(source.ipv4, "ipv4");
	addRanges(source.ipv6, "ipv6");
}

export const isAgentIp = (ip: string): boolean =>
	agentRanges.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

export function hasAgentToken(userAgent: string): boolean {
	const text = userAgent.slice(0, MAX_SCANNED_USER_AGENT).toLowerCase();
	for (let i = 0; i + PREFIX <= text.length; i++) {
		const candidates = tokensByPrefix.get(text.slice(i, i + PREFIX));
		if (candidates) {
			for (const token of candidates) {
				if (text.startsWith(token, i)) {
					return true;
				}
			}
		}
	}
	return false;
}

export function decide({ headers, ip }: DecideInput): boolean {
	const userAgent = headers["user-agent"];
	return (
		(userAgent !== undefined && hasAgentToken(userAgent)) ||
		headers["signature-agent"] !== undefined ||
		headers.dpop !== undefined ||
		headers.authorization?.toLowerCase() === "dpop" ||
		(ip !== null && isAgentIp(ip))
	);
}
