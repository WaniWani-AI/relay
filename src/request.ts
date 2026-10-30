import { clientIp, HEADER_CAP } from "./headers";
import { detectPlatform, type Platform } from "./platform";

/** `event.Records[0].cf.request` of a Lambda@Edge viewer-request event. */
export type CloudFrontRequest = {
	clientIp: string;
	method: string;
	uri: string;
	querystring: string;
	headers: Record<string, Array<{ key?: string; value: string }>>;
};

export type RelayRequest = {
	url: string | null;
	method: string;
	headers: Headers;
	ip: string | null;
	platform: Platform | undefined;
};

export function isCloudFrontRequest(
	input: Request | CloudFrontRequest,
): input is CloudFrontRequest {
	return (
		typeof Reflect.get(input, "clientIp") === "string" &&
		typeof Reflect.get(input, "uri") === "string"
	);
}

/** The origin for a `host` header, or null when the value holds more than a host and an optional port. */
function originOf(host: string | undefined): string | null {
	if (!host) {
		return null;
	}
	try {
		const url = new URL(`https://${host}`);
		const bare =
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			url.username === "" &&
			url.password === "";
		return bare ? url.origin : null;
	} catch {
		return null;
	}
}

/** Copies only the headers the relay reads, so a cookie or a value `Headers` refuses never makes the request fail. */
function cloudFrontHeaders(input: CloudFrontRequest["headers"]): Headers {
	const headers = new Headers();
	for (const name of HEADER_CAP) {
		for (const entry of input?.[name] ?? []) {
			if (typeof entry?.value !== "string") {
				continue;
			}
			try {
				headers.append(name, entry.value);
			} catch {}
		}
	}
	return headers;
}

/** The client can set `X-Forwarded-For` at viewer-request, so a CloudFront request takes its IP from `clientIp` alone. `url` is null when the host header is missing or malformed. */
export function toRelayRequest(
	input: Request | CloudFrontRequest,
): RelayRequest {
	if (!isCloudFrontRequest(input)) {
		return {
			url: input.url,
			method: input.method,
			headers: input.headers,
			ip: clientIp(input.headers),
			platform: detectPlatform(),
		};
	}
	const origin = originOf(input.headers?.host?.[0]?.value);
	const query = input.querystring ? `?${input.querystring}` : "";
	const ip = input.clientIp.trim().toLowerCase();
	return {
		url: origin === null ? null : `${origin}${input.uri}${query}`,
		method: input.method,
		headers: cloudFrontHeaders(input.headers),
		ip: ip ? ip : null,
		platform: "cloudfront",
	};
}
