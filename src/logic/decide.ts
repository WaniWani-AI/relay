import { BlockList } from "node:net";
import agents from "./agents.generated.json";
import ranges from "./ip-ranges.generated.json";

export type DecideInput = {
	headers: Record<string, string>;
	ip: string | null;
	useBundled?: boolean;
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

const bundled = compile({ tokens: agents.tokens, ipRanges: ranges.sources });
let remote: CompiledRules | null = null;

/** Sets the remote match rules. Throws, and keeps the current ones, when a range is malformed. */
export function applyRules(rules: MatchRules): void {
	remote = compile(rules);
}

const pick = (useBundled: boolean): CompiledRules =>
	useBundled ? bundled : (remote ?? bundled);

export const isAgentIp = (ip: string, useBundled = false): boolean =>
	pick(useBundled).agentRanges.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

export function hasAgentToken(userAgent: string, useBundled = false): boolean {
	const { tokensByPrefix } = pick(useBundled);
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

export function decide({
	headers,
	ip,
	useBundled = false,
}: DecideInput): boolean {
	const userAgent = headers["user-agent"];
	return (
		(userAgent !== undefined && hasAgentToken(userAgent, useBundled)) ||
		headers["signature-agent"] !== undefined ||
		headers.dpop !== undefined ||
		headers.authorization?.toLowerCase() === "dpop" ||
		(ip !== null && isAgentIp(ip, useBundled))
	);
}
