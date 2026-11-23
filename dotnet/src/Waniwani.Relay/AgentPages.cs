using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Waniwani.Relay
{
    internal static class Settings
    {
        public const int RequestTimeoutMs = 2000;
        public const int RetryDelayMs = 500;
        public const long RulesRefreshMs = 12L * 60 * 60 * 1000;
        public const long RulesRetryMs = 5L * 60 * 1000;
        public const int SiteRulesTimeoutMs = 300;
        public const long SiteRulesRefreshMs = 60_000;
        public const long SiteRulesRetryMs = 5_000;
        public const int AskMaxBodyBytes = 16_384;
        public const string AskPath = "/ask";
        public const string UsApiUrl = "https://app.waniwani.ai";
        public const string EuApiUrl = "https://eu.app.waniwani.ai";
    }

    internal interface IClock
    {
        long NowMs { get; }
    }

    internal sealed class SystemClock : IClock
    {
        private static readonly Stopwatch Watch = Stopwatch.StartNew();

        public long NowMs => Watch.ElapsedMilliseconds;
    }

    internal sealed class AgentPageRequest
    {
        public AgentPageRequest(string hostname, string path, string query, PageFormat format, string userAgent, byte[]? body)
        {
            Hostname = hostname;
            Path = path;
            Query = query;
            Format = format;
            UserAgent = userAgent;
            Body = body;
        }

        public string Hostname { get; }
        public string Path { get; }
        public string Query { get; }
        public PageFormat Format { get; }
        public string UserAgent { get; }
        public byte[]? Body { get; }
    }

    internal sealed class AgentPage
    {
        public AgentPage(int status, byte[]? body, string? contentType, string? retryAfter)
        {
            Status = status;
            Body = body;
            ContentType = contentType;
            RetryAfter = retryAfter;
        }

        public int Status { get; }
        public byte[]? Body { get; }
        public string? ContentType { get; }
        public string? RetryAfter { get; }
    }

    internal static class AgentPages
    {
        private static readonly HashSet<string> JsonPaths = new HashSet<string>(StringComparer.Ordinal)
        {
            Settings.AskPath, "/.well-known/ai-catalog.json", "/openapi.json", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json",
        };

        private static bool ServableType(string path, string contentType)
        {
            var semicolon = contentType.IndexOf(';');
            var type = Text.ToLowerJs(Text.TrimJs(semicolon >= 0 ? contentType.Substring(0, semicolon) : contentType));
            return type.StartsWith("text/", StringComparison.Ordinal) || (JsonPaths.Contains(path) && type == "application/json");
        }

        public static async Task<AgentPage?> FetchAsync(HttpClient http, SiteRules rules, AgentPageRequest page, string relayVersion)
        {
            var path = page.Path == "/" ? string.Empty : page.Path;
            var search = page.Query.Length == 0 ? string.Empty : "?" + page.Query;
            var url = rules.PagesUrl + "/" + page.Hostname + path + search;
            var ask = page.Path == Settings.AskPath;
            using (var cancel = new CancellationTokenSource())
            {
                try
                {
                    using (var request = new HttpRequestMessage(page.Body != null ? HttpMethod.Post : HttpMethod.Get, url))
                    {
                        request.Headers.TryAddWithoutValidation("accept", page.Format == PageFormat.Markdown ? "text/markdown" : "text/html");
                        request.Headers.TryAddWithoutValidation("x-waniwani-relay", relayVersion);
                        if (page.UserAgent.Length > 0)
                        {
                            request.Headers.TryAddWithoutValidation("x-waniwani-agent", page.UserAgent);
                        }
                        if (page.Body != null)
                        {
                            request.Content = new ByteArrayContent(page.Body);
                            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                        }
                        var headersDeadline = ToTimeSpan(ask ? rules.AskMs : rules.HeadersMs);
                        var sending = http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel.Token);
                        var first = await Task.WhenAny(sending, Task.Delay(headersDeadline)).ConfigureAwait(false);
                        if (first != sending)
                        {
                            cancel.Cancel();
                            Observe(sending);
                            return null;
                        }
                        using (var response = await sending.ConfigureAwait(false))
                        {
                            var status = (int)response.StatusCode;
                            var contentType = response.Content.Headers.ContentType?.ToString() ?? string.Empty;
                            var servable = ServableType(page.Path, contentType);
                            if (status == 429 && ask)
                            {
                                byte[]? limitedBody = null;
                                if (servable)
                                {
                                    limitedBody = await ReadWithinAsync(response, rules.BodyMs, rules.MaxBodyBytes, cancel).ConfigureAwait(false);
                                }
                                var retryAfter = response.Headers.TryGetValues("retry-after", out var values) ? string.Join(", ", values) : null;
                                return new AgentPage(429, limitedBody, limitedBody != null ? contentType : null, retryAfter);
                            }
                            if (status != 200 || !servable)
                            {
                                return null;
                            }
                            var body = await ReadWithinAsync(response, rules.BodyMs, rules.MaxBodyBytes, cancel).ConfigureAwait(false);
                            return body != null ? new AgentPage(200, body, contentType, null) : null;
                        }
                    }
                }
                catch
                {
                    return null;
                }
                finally
                {
                    cancel.Cancel();
                }
            }
        }

        private static TimeSpan ToTimeSpan(double milliseconds)
        {
            return TimeSpan.FromMilliseconds(Math.Min(milliseconds, int.MaxValue));
        }

        private static void Observe(Task task)
        {
            task.ContinueWith(t => t.Exception, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        }

        private static async Task<byte[]?> ReadWithinAsync(HttpResponseMessage response, double milliseconds, double maxBytes, CancellationTokenSource cancel)
        {
            var reading = ReadCappedAsync(response, maxBytes, cancel.Token);
            var first = await Task.WhenAny(reading, Task.Delay(ToTimeSpan(milliseconds))).ConfigureAwait(false);
            if (first != reading)
            {
                cancel.Cancel();
                Observe(reading);
                return null;
            }
            return await reading.ConfigureAwait(false);
        }

        private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage response, double maxBytes, CancellationToken token)
        {
            using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
            using (var buffer = new MemoryStream())
            {
                var chunk = new byte[16 * 1024];
                while (true)
                {
                    var read = await stream.ReadAsync(chunk, 0, chunk.Length, token).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }
                    if (buffer.Length + read > maxBytes)
                    {
                        return null;
                    }
                    buffer.Write(chunk, 0, read);
                }
                return buffer.ToArray();
            }
        }
    }
}
