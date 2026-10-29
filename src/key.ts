export type RelayKey = { ingestToken: string; orgKey: string };

const KEY = /^wwt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+={0,2})$/;

let warnedMalformed = false;

export function readKey(explicit: string | undefined): RelayKey | null {
	const raw = explicit ?? readEnv("WANIWANI_AGENT_TRAFFIC_KEY");
	if (raw === undefined || raw.trim() === "") {
		return null;
	}
	const match = KEY.exec(raw.trim());
	if (!match?.[1] || !match[2]) {
		if (!warnedMalformed) {
			warnedMalformed = true;
			console.warn(
				"[@waniwani/relay] WANIWANI_AGENT_TRAFFIC_KEY is malformed, so no agent visits are recorded. Copy the key again from the WaniWani setup screen.",
			);
		}
		return null;
	}
	return { ingestToken: match[1], orgKey: match[2] };
}

function readEnv(name: string): string | undefined {
	try {
		return typeof process === "undefined" ? undefined : process.env[name];
	} catch {
		return undefined;
	}
}
