const AI_ASSISTANT_HOSTS = [
	"chatgpt.com",
	"chat.openai.com",
	"com.openai.chatgpt",
	"claude.ai",
	"perplexity.ai",
	"gemini.google.com",
	"copilot.microsoft.com",
	"meta.ai",
];

const REFERER_SCHEMES = new Set(["http:", "https:", "android-app:"]);

/** The scheme and host of a `Referer` whose host is an AI assistant, for example `https://chatgpt.com/`, or null. */
export function aiAssistantReferer(referer: string | undefined): string | null {
	if (referer === undefined) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(referer.trim());
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const known = AI_ASSISTANT_HOSTS.some(
		(assistant) => host === assistant || host.endsWith(`.${assistant}`),
	);
	return known && REFERER_SCHEMES.has(url.protocol)
		? `${url.protocol}//${host}/`
		: null;
}

const UTM_SOURCE_HOSTS: Record<string, string> = {
	chatgpt: "chatgpt.com",
	openai: "chatgpt.com",
	claude: "claude.ai",
	perplexity: "perplexity.ai",
	gemini: "gemini.google.com",
	copilot: "copilot.microsoft.com",
	...Object.fromEntries(AI_ASSISTANT_HOSTS.map((host) => [host, host])),
};

/** `https://` and the host of the AI assistant that a `utm_source` value names, for example `https://chatgpt.com/` for `chatgpt.com`, or null. */
export function aiAssistantUtmSource(
	utmSource: string | null | undefined,
): string | null {
	if (utmSource === null || utmSource === undefined) {
		return null;
	}
	const name = utmSource.trim().toLowerCase();
	return Object.hasOwn(UTM_SOURCE_HOSTS, name)
		? `https://${UTM_SOURCE_HOSTS[name]}/`
		: null;
}
