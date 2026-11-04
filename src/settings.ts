export const settings = {
	apiUrls: {
		us: "https://app.waniwani.ai",
		eu: "https://eu.app.waniwani.ai",
	},
	requestTimeoutMs: 2000,
	cloudFrontTimeoutMs: 1000,
	cloudFrontMaxUriBytes: 8192,
	cloudFrontMaxBodyBytes: 1_000_000 - 16_384,
	retryDelayMs: 500,
	rulesRefreshMs: 12 * 60 * 60 * 1000,
	rulesRetryMs: 5 * 60 * 1000,
	siteRulesTimeoutMs: 300,
	siteRulesRefreshMs: 60_000,
	siteRulesRetryMs: 5_000,
};
