const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function importOrgKey(orgKey: string): Promise<CryptoKey> {
	let key = keys.get(orgKey);
	if (!key) {
		key = crypto.subtle.importKey(
			"raw",
			encoder.encode(orgKey),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		key.catch(() => keys.delete(orgKey));
		keys.set(orgKey, key);
	}
	return key;
}

const toHex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

export async function deriveMatchKey(
	orgKey: string,
	ip: string,
): Promise<string> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		await importOrgKey(orgKey),
		encoder.encode(ip),
	);
	return toHex(signature);
}
