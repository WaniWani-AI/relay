import { BlockList } from "node:net";
import agents from "./agents.json";
import ranges from "./ip-ranges.generated.json";

export type DecideInput = {
	headers: Record<string, string>;
	ip: string | null;
};

export type MatchRules = {
	tokens: string[];
	ipRanges: Array<{ ipv4: string[]; ipv6: string[] }>;
};

const MAX_SCANNED_USER_AGENT = 1024;
const PREFIX = 3;

type CompiledRules = {
	tokensByPrefix: Map<string, string[]>;
	agentRanges: BlockList;
};

function compile(rules: MatchRules): CompiledRules {
	const tokensByPrefix = new Map<string, string[]>();
	for (const token of rules.tokens) {
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
	for (const source of rules.ipRanges) {
		addRanges(source.ipv4, "ipv4");
		addRanges(source.ipv6, "ipv6");
	}

	return { tokensByPrefix, agentRanges };
}

let active = compile({ tokens: agents.tokens, ipRanges: ranges.sources });

/** Swaps the active match rules. Throws, and keeps the active rules, when a range is malformed. */
export function applyRules(rules: MatchRules): void {
	active = compile(rules);
}

export const isAgentIp = (ip: string): boolean =>
	active.agentRanges.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

export function hasAgentToken(userAgent: string): boolean {
	const text = userAgent.slice(0, MAX_SCANNED_USER_AGENT).toLowerCase();
	for (let i = 0; i + PREFIX <= text.length; i++) {
		const candidates = active.tokensByPrefix.get(text.slice(i, i + PREFIX));
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
