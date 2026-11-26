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
