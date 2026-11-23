import { BlockList, isIP } from "node:net";

export type ClientIpInput = {
	remoteAddress: string;
	headers: Record<string, string>;
	clientIpHeader: string | null;
	trustedProxies: string[];
};

/** The address in one header entry, without a port or IPv6 brackets, or null when it is not an IP address. */
export function parseAddress(entry: string): string | null {
	let value = entry.trim().toLowerCase();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
	if (bracketed?.[1]) {
		value = bracketed[1];
	} else if (/^[0-9.]+:\d+$/.test(value)) {
		value = value.slice(0, value.lastIndexOf(":"));
	}
	return isIP(value) === 0 ? null : value;
}

/** A BlockList of CIDRs and single addresses. Throws on a malformed entry. */
export function proxyList(entries: string[]): BlockList {
	const list = new BlockList();
	for (const entry of entries) {
		const [address = "", prefix, extra] = entry.trim().toLowerCase().split("/");
		const type = isIP(address);
		if (type === 0 || extra !== undefined) {
			throw new Error(`malformed proxy ${entry}`);
		}
		const family = type === 4 ? "ipv4" : "ipv6";
		if (prefix === undefined) {
			list.addAddress(address, family);
		} else {
			list.addSubnet(address, Number(prefix), family);
		}
	}
	return list;
}

const contains = (list: BlockList, address: string): boolean =>
	list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");

/**
 * The visitor IP for a server behind proxies. The header counts only when the direct peer is a trusted proxy.
 * In a list header, the rightmost entry that is not a trusted proxy is the visitor, because each proxy appends the address it saw.
 */
export function resolveClientIp(input: ClientIpInput): string | null {
	const remote = parseAddress(input.remoteAddress);
	if (remote === null) {
		return null;
	}
	if (input.clientIpHeader === null) {
		return remote;
	}
	const trusted = proxyList(input.trustedProxies);
	if (!contains(trusted, remote)) {
		return remote;
	}
	const value = input.headers[input.clientIpHeader.toLowerCase()];
	if (value === undefined || value.trim() === "") {
		return remote;
	}
	const entries = value.split(",");
	let leftmost: string | null = remote;
	for (let index = entries.length - 1; index >= 0; index--) {
		const address = parseAddress(entries[index] ?? "");
		if (address === null) {
			return leftmost;
		}
		if (!contains(trusted, address)) {
			return address;
		}
		leftmost = address;
	}
	return leftmost;
}
