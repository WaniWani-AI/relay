using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Waniwani.Relay
{
    /// <summary>Settings for the relay. The adapters read them from <c>web.config</c> or <c>appsettings.json</c>.</summary>
    public sealed class RelayOptions
    {
        /// <summary>The <c>wwt_</c> key from the Waniwani setup screen. Defaults to the <c>WANIWANI_AGENT_TRAFFIC_KEY</c> environment variable.</summary>
        public string? AgentTrafficKey { get; set; }

        /// <summary>The region of your Waniwani organization: <c>us</c> (default) or <c>eu</c>.</summary>
        public string Region { get; set; } = "us";

        /// <summary>Overrides the API host that <see cref="Region"/> picks. For tests.</summary>
        public string? BaseUrl { get; set; }

        /// <summary>The header in which your CDN or load balancer puts the visitor IP, for example <c>X-Forwarded-For</c>. Without it, the relay uses the address of the peer.</summary>
        public string? ClientIpHeader { get; set; }

        /// <summary>The addresses and CIDR ranges of your proxies. The relay reads <see cref="ClientIpHeader"/> only when the peer is in this list.</summary>
        public IList<string> TrustedProxies { get; set; } = new List<string>();

        /// <summary><c>remote</c> (default) loads the newest AI bot list from Waniwani every 12 hours. <c>bundled</c> keeps the list in this package.</summary>
        public string Rules { get; set; } = "remote";

        /// <summary>Header names, and the fields <c>matchKey</c>, <c>userAgent</c> or <c>referer</c>, to leave out of every event.</summary>
        public IList<string> Omit { get; set; } = new List<string>();

        /// <summary>Set to false to turn the relay off without a deploy.</summary>
        public bool Enabled { get; set; } = true;
    }

    /// <summary>One incoming request, as the adapter sees it.</summary>
    public sealed class RelayRequest
    {
        public RelayRequest(string method, string? host, string path, string query, IReadOnlyDictionary<string, string> headers, string remoteAddress)
        {
            Method = method;
            Host = host;
            Path = path;
            Query = query;
            Headers = headers;
            RemoteAddress = remoteAddress;
        }

        public string Method { get; }

        /// <summary>The value of the <c>host</c> header.</summary>
        public string? Host { get; }

        /// <summary>The path as the client sent it, without the query.</summary>
        public string Path { get; }

        /// <summary>The query string without the <c>?</c>.</summary>
        public string Query { get; }

        /// <summary>Lowercase header names. Repeated headers joined with <c>", "</c>.</summary>
        public IReadOnlyDictionary<string, string> Headers { get; }

        /// <summary>The address of the peer, for example <c>REMOTE_ADDR</c>.</summary>
        public string RemoteAddress { get; }

        /// <summary>Reads the request body for <c>POST /ask</c> and leaves it readable for the site. Returns null when the body is longer than <c>maxBytes</c> or slower than the deadline.</summary>
        public Func<int, TimeSpan, Task<byte[]?>>? ReadBody { get; set; }

        internal bool? Agent { get; set; }
    }

    /// <summary>The answer that the adapter writes in place of the site response.</summary>
    public sealed class RelayAnswer
    {
        internal RelayAnswer(int status, IReadOnlyList<KeyValuePair<string, string>> headers, byte[]? body)
        {
            Status = status;
            Headers = headers;
            Body = body;
        }

        public int Status { get; }
        public IReadOnlyList<KeyValuePair<string, string>> Headers { get; }
        public byte[]? Body { get; }
    }

    /// <summary>The Waniwani relay. Create one for the process and share it between requests. No method throws.</summary>
    public sealed class Relay
    {
        public const string RecordAgentVisitName = "recordAgentVisit";
        public const string ServeAgentPageName = "serveAgentPage";

        private static readonly AgentRules Bundled = AgentRules.LoadBundled();

        private readonly RelayOptions _options;
        private readonly string _platform;
        private readonly HttpClient _http;
        private readonly IClock _clock;
        private readonly RelayKey? _key;
        private readonly string? _apiUrl;
        private readonly IpRangeSet _trustedProxies;
        private readonly HashSet<string> _omit;
        private readonly SiteRulesCache _siteRules;
        private readonly IngestQueue _ingest;
        private readonly object _usedGate = new object();
        private readonly List<string> _used = new List<string>();
        private readonly HashSet<string> _warned = new HashSet<string>(StringComparer.Ordinal);
        private AgentRules? _remote;
        private long _rulesLastAttemptAt = long.MinValue;
        private bool _rulesLastAttemptOk;
        private int _rulesInFlight;

        public Relay(RelayOptions options, string platform)
            : this(options, platform, DefaultHttp.Value, new SystemClock(), null)
        {
        }

        internal Relay(RelayOptions options, string platform, HttpClient http, IClock clock, string? relayVersion)
        {
            _options = options;
            _platform = platform;
            _http = http;
            _clock = clock;
            RelayVersion = relayVersion ?? PackageVersion;
            _key = RelayKey.Parse(options.AgentTrafficKey ?? Environment.GetEnvironmentVariable("WANIWANI_AGENT_TRAFFIC_KEY"));
            var rawKey = options.AgentTrafficKey ?? Environment.GetEnvironmentVariable("WANIWANI_AGENT_TRAFFIC_KEY");
            if (_key == null && !string.IsNullOrWhiteSpace(rawKey))
            {
                Warn("key", "Waniwani:AgentTrafficKey is malformed, so no agent visits are recorded. Copy the key again from the Waniwani setup screen.");
            }
            _apiUrl = ResolveApiUrl(options);
            _trustedProxies = BuildProxies(options.TrustedProxies);
            _omit = new HashSet<string>(options.Omit.Select(name => Text.ToLowerJs(name)), StringComparer.Ordinal);
            if (_omit.Contains("useragent"))
            {
                _omit.Add("user-agent");
            }
            _siteRules = new SiteRulesCache(http, clock);
            _ingest = new IngestQueue(http, message => Warn("ingest", message));
        }

        private static readonly Lazy<HttpClient> DefaultHttp = new Lazy<HttpClient>(() =>
        {
            var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
            client.DefaultRequestHeaders.TryAddWithoutValidation("user-agent", "waniwani-relay-dotnet/" + PackageVersion);
            return client;
        });

        /// <summary>The version of this package, which is the TypeScript relay version whose fixtures it passes.</summary>
        public static string PackageVersion { get; } = ReadPackageVersion();

        internal string RelayVersion { get; }

        public bool Enabled => _options.Enabled;

        /// <summary>The configured client IP header in lowercase, or null. The adapter copies this header into <see cref="RelayRequest.Headers"/>.</summary>
        public string? ClientIpHeader => string.IsNullOrWhiteSpace(_options.ClientIpHeader) ? null : Text.ToLowerJs(_options.ClientIpHeader!.Trim());

        private static string ReadPackageVersion()
        {
            var informational = typeof(Relay).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0-dev";
            var plus = informational.IndexOf('+');
            return plus >= 0 ? informational.Substring(0, plus) : informational;
        }

        private IpRangeSet BuildProxies(IList<string> entries)
        {
            try
            {
                return ClientIp.ProxyList(entries.Where(entry => !string.IsNullOrWhiteSpace(entry)));
            }
            catch (FormatException error)
            {
                Warn("proxies", "Waniwani:TrustedProxies holds an entry that is not an IP address or CIDR (" + error.Message + "), so the relay ignores the client IP header.");
                return IpRangeSet.Empty;
            }
        }

        private string? ResolveApiUrl(RelayOptions options)
        {
            if (!string.IsNullOrWhiteSpace(options.BaseUrl))
            {
                return options.BaseUrl!.TrimEnd('/');
            }
            switch (Text.ToLowerJs(options.Region ?? "us"))
            {
                case "us":
                    return Settings.UsApiUrl;
                case "eu":
                    return Settings.EuApiUrl;
                default:
                    Warn("region", "Unknown region \"" + options.Region + "\", so no agent visits are recorded. Use \"us\" or \"eu\".");
                    return null;
            }
        }

        private void Warn(string kind, string message)
        {
            lock (_warned)
            {
                if (!_warned.Add(kind))
                {
                    return;
                }
            }
            Trace.TraceWarning("[Waniwani.Relay] " + message);
        }

        private void Use(string name)
        {
            lock (_usedGate)
            {
                if (!_used.Contains(name))
                {
                    _used.Add(name);
                }
            }
        }

        private string[] Used()
        {
            lock (_usedGate)
            {
                return _used.ToArray();
            }
        }

        /// <summary>The visitor IP of the request.</summary>
        public string? ClientIpOf(RelayRequest request)
        {
            try
            {
                return ClientIp.Resolve(request.RemoteAddress, request.Headers, ClientIpHeader, _trustedProxies);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>True when the request comes from an AI agent. Reads headers only and never waits on the network.</summary>
        public bool IsAgent(RelayRequest request)
        {
            if (!_options.Enabled)
            {
                return false;
            }
            StartRulesRefresh();
            var agent = MatchesAgent(request);
            request.Agent = agent;
            return agent;
        }

        private bool MatchesAgent(RelayRequest request)
        {
            try
            {
                return CurrentRules().Decide(CappedHeaders.Read(request.Headers), ClientIpOf(request));
            }
            catch
            {
                return false;
            }
        }

        private AgentRules CurrentRules() =>
            string.Equals(_options.Rules, "bundled", StringComparison.OrdinalIgnoreCase) ? Bundled : Volatile.Read(ref _remote) ?? Bundled;

        /// <summary>True when the request comes from a person who followed a link in an AI assistant: the <c>referer</c> host is an AI assistant, for example <c>chatgpt.com</c> or the ChatGPT app, or the <c>utm_source</c> query parameter names one, for example <c>utm_source=chatgpt.com</c>, and the request does not come from an AI agent. Reads the headers and the query only and never waits on the network.</summary>
        public bool IsAiReferral(RelayRequest request)
        {
            if (!_options.Enabled)
            {
                return false;
            }
            StartRulesRefresh();
            try
            {
                return AiReferralOrigin(CappedHeaders.Read(request.Headers), request.Query, ClientIpOf(request)) != null;
            }
            catch
            {
                return false;
            }
        }

        private string? AiReferralOrigin(IReadOnlyDictionary<string, string> capped, string query, string? ip)
        {
            var referer = AiAssistantReferer.Of(capped.TryGetValue("referer", out var value) ? value : null) ?? AiAssistantReferer.OfQuery(query);
            return referer != null && !CurrentRules().Decide(capped, ip) ? referer : null;
        }

        private void StartRulesRefresh()
        {
            try
            {
                if (_apiUrl == null || string.Equals(_options.Rules, "bundled", StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                var now = _clock.NowMs;
                var wait = Volatile.Read(ref _rulesLastAttemptOk) ? Settings.RulesRefreshMs : Settings.RulesRetryMs;
                var last = Interlocked.Read(ref _rulesLastAttemptAt);
                if (last != long.MinValue && now - last < wait)
                {
                    return;
                }
                if (Interlocked.CompareExchange(ref _rulesInFlight, 1, 0) != 0)
                {
                    return;
                }
                Interlocked.Exchange(ref _rulesLastAttemptAt, now);
                Volatile.Write(ref _rulesLastAttemptOk, false);
                _ = Task.Run(RefreshRulesAsync);
            }
            catch
            {
            }
        }

        private async Task RefreshRulesAsync()
        {
            try
            {
                using (var cancel = new CancellationTokenSource(Settings.RequestTimeoutMs))
                using (var response = await _http.GetAsync(_apiUrl + "/api/v2/agent-traffic/rules", cancel.Token).ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode)
                    {
                        return;
                    }
                    var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var data = JsonValue.Parse(text).Get("data");
                    var rules = data != null ? AgentRules.ParseRemote(data) : null;
                    if (rules != null)
                    {
                        Volatile.Write(ref _remote, rules);
                        Volatile.Write(ref _rulesLastAttemptOk, true);
                    }
                }
            }
            catch
            {
            }
            finally
            {
                Interlocked.Exchange(ref _rulesInFlight, 0);
            }
        }

        /// <summary>Queues one event for this request. Sends nothing when no key is set. The post happens in the background.</summary>
        public void RecordAgentVisit(RelayRequest request)
        {
            Use(RecordAgentVisitName);
            try
            {
                if (!_options.Enabled || _key == null || _apiUrl == null)
                {
                    return;
                }
                var host = HostName.Of(request.Host);
                if (host == null)
                {
                    return;
                }
                var capped = CappedHeaders.Read(request.Headers);
                var ip = ClientIpOf(request);
                var referral = AiReferralOrigin(capped, request.Query, ip);
                if (referral != null && _omit.Contains("referer"))
                {
                    return;
                }
                var headers = new Dictionary<string, string>(StringComparer.Ordinal);
                if (referral == null)
                {
                    foreach (var pair in capped)
                    {
                        if (!_omit.Contains(pair.Key))
                        {
                            headers[pair.Key] = pair.Value;
                        }
                    }
                }
                var userAgent = capped.TryGetValue("user-agent", out var ua) && !_omit.Contains("user-agent") ? ua : null;
                var referer = referral ?? (capped.TryGetValue("referer", out var r) && !_omit.Contains("referer") ? r : null);
                var matchKey = referral == null && ip != null && !_omit.Contains("matchkey") ? MatchKey.Derive(_key.OrgKey, ip) : null;
                var visitor = referral == null ? null : "aiReferral";
                var occurredAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
                var sourceEventId = Guid.NewGuid().ToString();
                var method = request.Method.ToUpperInvariant();
                var path = (request.Path.Length == 0 ? "/" : request.Path) + (referral == null && request.Query.Length > 0 ? "?" + request.Query : string.Empty);
                var url = _apiUrl + "/api/v2/agent-traffic/ingest/middleware/" + _key.IngestToken;
                _ingest.Enqueue(new PendingRecord(url, () => RecordJson.Write(occurredAt, method, host, path, headers, sourceEventId, RelayVersion, Used(), userAgent, referer, _platform, matchKey, visitor)));
            }
            catch
            {
            }
        }

        /// <summary>True when this request can get an answer from <see cref="ServeAgentPageAsync"/> by the rules in memory, or when no rules are in memory yet. A site that blocks agents can answer on every path, so a cached response must not skip the block. Never waits.</summary>
        public bool MayServe(RelayRequest request)
        {
            try
            {
                if (!_options.Enabled || _key == null || _apiUrl == null)
                {
                    return false;
                }
                var rules = _siteRules.Peek(_apiUrl, _key.IngestToken);
                if (rules == null)
                {
                    return true;
                }
                var host = HostName.Of(request.Host);
                var site = rules.Sites.FirstOrDefault(entry => entry.Hostname == host);
                return site != null && (site.BlockedUserAgentTokens.Count > 0 || (site.AgentPagesEnabled && Paths.Matches(Paths.Normalize(request.Path), site.Paths)));
            }
            catch
            {
                return false;
            }
        }

        /// <summary>The 403 block, the stored agent page, the <c>/ask</c> rate limit, or null. Null means the site gives its usual response.</summary>
        public async Task<RelayAnswer?> ServeAgentPageAsync(RelayRequest request)
        {
            Use(ServeAgentPageName);
            try
            {
                if (!_options.Enabled)
                {
                    return null;
                }
                return await AnswerAsync(request).ConfigureAwait(false);
            }
            catch
            {
                return null;
            }
        }

        private static readonly KeyValuePair<string, string>[] BlockedHeaders =
        {
            new KeyValuePair<string, string>("content-type", "text/plain; charset=utf-8"),
            new KeyValuePair<string, string>("x-waniwani-blocked", "1"),
            new KeyValuePair<string, string>("cache-control", "private, no-store"),
            new KeyValuePair<string, string>("vary", "user-agent"),
        };

        private async Task<RelayAnswer?> AnswerAsync(RelayRequest request)
        {
            var method = request.Method.ToUpperInvariant();
            var path = Paths.Normalize(request.Path.Length == 0 ? "/" : request.Path);
            var ask = method == "POST" && path == Settings.AskPath;
            var accept = request.Headers.TryGetValue("accept", out var a) ? a : string.Empty;
            if (!(method == "GET" || method == "HEAD" || ask))
            {
                return null;
            }
            if (!(request.Agent ?? MatchesAgent(request)) && !Accept.PrefersMarkdown(accept))
            {
                return null;
            }
            if (_key == null || _apiUrl == null)
            {
                return null;
            }
            var hostname = HostName.Of(request.Host);
            if (hostname == null)
            {
                return null;
            }
            var rules = await _siteRules.LoadAsync(_apiUrl, _key.IngestToken).ConfigureAwait(false);
            var site = rules?.Sites.FirstOrDefault(entry => entry.Hostname == hostname);
            if (rules == null || site == null)
            {
                return null;
            }
            var rawUserAgent = request.Headers.TryGetValue("user-agent", out var u) ? u : string.Empty;
            var userAgent = Text.ToLowerJs(rawUserAgent);
            if (site.BlockedUserAgentTokens.Any(token => userAgent.IndexOf(token, StringComparison.Ordinal) >= 0))
            {
                return new RelayAnswer(403, BlockedHeaders, method == "HEAD" ? null : Encoding.UTF8.GetBytes("Forbidden"));
            }
            if (request.Headers.ContainsKey("x-waniwani-render") || !site.AgentPagesEnabled || !Paths.Matches(path, site.Paths))
            {
                return null;
            }
            PageFormat format;
            if (rules.UserAgentTokens.Any(token => userAgent.IndexOf(token, StringComparison.Ordinal) >= 0))
            {
                format = Accept.PageFormatOf(accept);
            }
            else if (Accept.PrefersMarkdown(accept))
            {
                format = PageFormat.Markdown;
            }
            else
            {
                return null;
            }
            byte[]? body = null;
            if (ask)
            {
                body = await ReadAskBodyAsync(request, rules).ConfigureAwait(false);
                if (body == null)
                {
                    return null;
                }
            }
            var page = await AgentPages.FetchAsync(_http, rules, new AgentPageRequest(hostname, path, request.Query, format, rawUserAgent, body), RelayVersion).ConfigureAwait(false);
            if (page == null)
            {
                return null;
            }
            var headers = new List<KeyValuePair<string, string>>();
            if (page.ContentType != null)
            {
                headers.Add(new KeyValuePair<string, string>("content-type", page.ContentType));
            }
            if (page.RetryAfter != null)
            {
                headers.Add(new KeyValuePair<string, string>("retry-after", page.RetryAfter));
            }
            headers.Add(new KeyValuePair<string, string>("x-waniwani-agent-page", "hit"));
            headers.Add(new KeyValuePair<string, string>("cache-control", "private, no-store"));
            headers.Add(new KeyValuePair<string, string>("vary", "user-agent, accept"));
            return new RelayAnswer(page.Status, headers, method == "HEAD" ? null : page.Body);
        }

        private static async Task<byte[]?> ReadAskBodyAsync(RelayRequest request, SiteRules rules)
        {
            if (request.Headers.TryGetValue("content-length", out var length) && JsNumber.Parse(length) > Settings.AskMaxBodyBytes)
            {
                return null;
            }
            if (request.ReadBody == null)
            {
                return null;
            }
            var body = await request.ReadBody(Settings.AskMaxBodyBytes, TimeSpan.FromMilliseconds(Math.Min(rules.BodyMs, int.MaxValue))).ConfigureAwait(false);
            return body != null && body.Length > 0 ? body : null;
        }

        /// <summary>Stops taking events and waits up to <paramref name="timeout"/> for the queue to empty. Call it when the app shuts down.</summary>
        public Task ShutdownAsync(TimeSpan timeout)
        {
            try
            {
                return _ingest.DrainAsync(timeout);
            }
            catch
            {
                return Task.CompletedTask;
            }
        }

        internal int DroppedRecords => _ingest.Dropped;
    }
}
