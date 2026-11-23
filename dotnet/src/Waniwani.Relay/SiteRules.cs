using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Waniwani.Relay
{
    internal sealed class SiteRules
    {
        public const double DefaultAskMs = 3000;

        public SiteRules(string pagesUrl, IReadOnlyList<string> userAgentTokens, double headersMs, double bodyMs, double askMs, double maxBodyBytes, IReadOnlyList<Site> sites)
        {
            PagesUrl = pagesUrl;
            UserAgentTokens = userAgentTokens;
            HeadersMs = headersMs;
            BodyMs = bodyMs;
            AskMs = askMs;
            MaxBodyBytes = maxBodyBytes;
            Sites = sites;
        }

        public string PagesUrl { get; }
        public IReadOnlyList<string> UserAgentTokens { get; }
        public double HeadersMs { get; }
        public double BodyMs { get; }
        public double AskMs { get; }
        public double MaxBodyBytes { get; }
        public IReadOnlyList<Site> Sites { get; }

        internal sealed class Site
        {
            public Site(string hostname, IReadOnlyList<string> blockedUserAgentTokens, bool agentPagesEnabled, IReadOnlyList<string> paths)
            {
                Hostname = hostname;
                BlockedUserAgentTokens = blockedUserAgentTokens;
                AgentPagesEnabled = agentPagesEnabled;
                Paths = paths;
            }

            public string Hostname { get; }
            public IReadOnlyList<string> BlockedUserAgentTokens { get; }
            public bool AgentPagesEnabled { get; }
            public IReadOnlyList<string> Paths { get; }
        }

        private static List<string> CleanTokens(IEnumerable<string> tokens)
        {
            return tokens.Select(token => Text.ToLowerJs(Text.TrimJs(token))).Where(token => token.Length > 0).ToList();
        }

        /// <summary>The site rules in the <c>data</c> of the serve rules answer, or null when it does not have the expected form.</summary>
        public static SiteRules? Parse(JsonValue body)
        {
            if (body.Kind != JsonKind.Object || !Json.IsNumber(body, "version", 1))
            {
                return null;
            }
            var pagesUrl = body.Get("pagesUrl");
            if (pagesUrl == null || pagesUrl.Kind != JsonKind.String)
            {
                return null;
            }
            if (!Json.TryStringArray(body, "userAgentTokens", out var tokens))
            {
                return null;
            }
            var deadlines = body.Get("deadlines");
            if (deadlines == null || deadlines.Kind != JsonKind.Object)
            {
                return null;
            }
            if (!Json.TryPositive(deadlines, "headersMs", out var headersMs) || !Json.TryPositive(deadlines, "bodyMs", out var bodyMs))
            {
                return null;
            }
            if (!Json.TryPositive(body, "maxBodyBytes", out var maxBodyBytes))
            {
                return null;
            }
            var sites = body.Get("sites");
            if (sites == null || sites.Kind != JsonKind.Array)
            {
                return null;
            }
            var parsedSites = new List<Site>();
            foreach (var site in sites.Items)
            {
                if (site.Kind != JsonKind.Object)
                {
                    return null;
                }
                var blockedProperty = site.Get("blockedUserAgentTokens");
                List<string> blocked;
                if (blockedProperty == null || blockedProperty.Kind == JsonKind.Null)
                {
                    blocked = new List<string>();
                }
                else if (!Json.TryStringArray(blockedProperty, out blocked))
                {
                    return null;
                }
                var hostname = site.Get("hostname");
                var agentPages = site.Get("agentPages");
                if (hostname == null || hostname.Kind != JsonKind.String || agentPages == null || agentPages.Kind != JsonKind.Object)
                {
                    return null;
                }
                var enabled = agentPages.Get("enabled");
                if (enabled == null || !enabled.IsBoolean || !Json.TryStringArray(agentPages, "paths", out var paths))
                {
                    return null;
                }
                parsedSites.Add(new Site(Text.ToLowerJs(hostname.String), CleanTokens(blocked), enabled.Kind == JsonKind.True, paths));
            }
            var askMs = Json.TryPositive(deadlines, "askMs", out var ask) ? ask : DefaultAskMs;
            return new SiteRules(pagesUrl.String.TrimEnd('/'), CleanTokens(tokens), headersMs, bodyMs, askMs, maxBodyBytes, parsedSites);
        }

        public string ToJson()
        {
            var writer = new JsonWriter();
            writer.StartObject().Number("version", 1).String("pagesUrl", PagesUrl).StartArray("userAgentTokens");
            foreach (var token in UserAgentTokens)
            {
                writer.String(null, token);
            }
            writer.EndArray().StartObject("deadlines").Number("headersMs", HeadersMs).Number("bodyMs", BodyMs).Number("askMs", AskMs).EndObject();
            writer.Number("maxBodyBytes", MaxBodyBytes).StartArray("sites");
            foreach (var site in Sites)
            {
                writer.StartObject().String("hostname", site.Hostname).StartArray("blockedUserAgentTokens");
                foreach (var token in site.BlockedUserAgentTokens)
                {
                    writer.String(null, token);
                }
                writer.EndArray().StartObject("agentPages").Boolean("enabled", site.AgentPagesEnabled).StartArray("paths");
                foreach (var path in site.Paths)
                {
                    writer.String(null, path);
                }
                writer.EndArray().EndObject().EndObject();
            }
            return writer.EndArray().EndObject().ToString();
        }
    }

    internal sealed class SiteRulesCache
    {
        private readonly HttpClient _http;
        private readonly IClock _clock;
        private readonly object _gate = new object();
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);

        public SiteRulesCache(HttpClient http, IClock clock)
        {
            _http = http;
            _clock = clock;
        }

        private sealed class Entry
        {
            public SiteRules? Rules;
            public long FetchedAt;
            public long LastAttemptAt = long.MinValue;
            public bool LastAttemptOk;
            public Task<SiteRules?>? InFlight;
        }

        /// <summary>The cached rules, without a wait. Null when no fetch has succeeded yet.</summary>
        public SiteRules? Peek(string apiUrl, string ingestToken)
        {
            lock (_gate)
            {
                return _entries.TryGetValue(Url(apiUrl, ingestToken), out var entry) ? entry.Rules : null;
            }
        }

        private static string Url(string apiUrl, string ingestToken)
        {
            return apiUrl + "/api/v2/agent-traffic/serve/" + ingestToken + "/rules";
        }

        public Task<SiteRules?> LoadAsync(string apiUrl, string ingestToken)
        {
            var url = Url(apiUrl, ingestToken);
            lock (_gate)
            {
                if (!_entries.TryGetValue(url, out var entry))
                {
                    entry = new Entry();
                    _entries[url] = entry;
                }
                var now = _clock.NowMs;
                if (entry.Rules != null)
                {
                    var stale = now - entry.FetchedAt >= Settings.SiteRulesRefreshMs;
                    var retryDue = entry.LastAttemptOk || now - entry.LastAttemptAt >= Settings.SiteRulesRetryMs;
                    if (stale && retryDue && entry.InFlight == null)
                    {
                        StartFetch(entry, url, Settings.RequestTimeoutMs);
                    }
                    return Task.FromResult<SiteRules?>(entry.Rules);
                }
                if (entry.InFlight != null)
                {
                    return entry.InFlight;
                }
                if (entry.LastAttemptAt != long.MinValue && now - entry.LastAttemptAt < Settings.SiteRulesRetryMs)
                {
                    return Task.FromResult<SiteRules?>(null);
                }
                return StartFetch(entry, url, Settings.SiteRulesTimeoutMs);
            }
        }

        private Task<SiteRules?> StartFetch(Entry entry, string url, int timeoutMs)
        {
            entry.LastAttemptAt = _clock.NowMs;
            entry.LastAttemptOk = false;
            var work = FetchAndStoreAsync(entry, url, timeoutMs);
            if (!work.IsCompleted)
            {
                entry.InFlight = work;
            }
            return work;
        }

        private async Task<SiteRules?> FetchAndStoreAsync(Entry entry, string url, int timeoutMs)
        {
            await Task.Yield();
            SiteRules? rules = null;
            try
            {
                rules = await FetchAsync(url, timeoutMs).ConfigureAwait(false);
            }
            catch
            {
            }
            lock (_gate)
            {
                if (rules != null)
                {
                    entry.Rules = rules;
                    entry.FetchedAt = _clock.NowMs;
                    entry.LastAttemptOk = true;
                }
                entry.InFlight = null;
            }
            return rules;
        }

        private async Task<SiteRules?> FetchAsync(string url, int timeoutMs)
        {
            using (var cancel = new CancellationTokenSource(timeoutMs))
            using (var response = await _http.GetAsync(url, cancel.Token).ConfigureAwait(false))
            {
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                cancel.Token.ThrowIfCancellationRequested();
                var data = JsonValue.Parse(text).Get("data");
                return data != null ? SiteRules.Parse(data) : null;
            }
        }
    }
}
