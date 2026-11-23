using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Waniwani.Relay.Tests
{
    internal sealed class FakeAnswer
    {
        public int Status;
        public Dictionary<string, string> Headers = new Dictionary<string, string>();
        public string? Body;
        public int HeaderDelayMs;
        public int BodyDelayMs;

        public static FakeAnswer From(JsonElement element)
        {
            return new FakeAnswer
            {
                Status = element.GetProperty("status").GetInt32(),
                Headers = element.TryGetProperty("headers", out var headers) ? Fixtures.Headers(headers) : new Dictionary<string, string>(),
                Body = Fixtures.String(element, "body"),
                HeaderDelayMs = element.TryGetProperty("headerDelayMs", out var h) ? h.GetInt32() : 0,
                BodyDelayMs = element.TryGetProperty("bodyDelayMs", out var b) ? b.GetInt32() : 0,
            };
        }
    }

    internal sealed class SeenRequest
    {
        public string Url = string.Empty;
        public string Method = string.Empty;
        public Dictionary<string, string> Headers = new Dictionary<string, string>();
        public string? Body;
    }

    internal sealed class FakeHandler : HttpMessageHandler
    {
        public readonly Dictionary<string, FakeAnswer?> Exact = new Dictionary<string, FakeAnswer?>();
        public readonly List<(string Prefix, FakeAnswer? Answer)> Prefixes = new List<(string, FakeAnswer?)>();
        public readonly ConcurrentQueue<SeenRequest> Seen = new ConcurrentQueue<SeenRequest>();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            var seen = new SeenRequest { Url = url, Method = request.Method.Method };
            foreach (var header in request.Headers)
            {
                seen.Headers[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
            }
            if (request.Content != null)
            {
                foreach (var header in request.Content.Headers)
                {
                    seen.Headers[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
                }
                seen.Body = await request.Content.ReadAsStringAsync(cancellationToken);
            }
            Seen.Enqueue(seen);
            FakeAnswer? answer;
            if (!Exact.TryGetValue(url, out answer))
            {
                var prefix = Prefixes.FirstOrDefault(entry => url.StartsWith(entry.Prefix, StringComparison.Ordinal));
                if (prefix.Prefix == null)
                {
                    throw new HttpRequestException("fetch failed");
                }
                answer = prefix.Answer;
            }
            if (answer == null)
            {
                throw new HttpRequestException("fetch failed");
            }
            if (answer.HeaderDelayMs > 0)
            {
                await Task.Delay(answer.HeaderDelayMs, cancellationToken);
            }
            var response = new HttpResponseMessage((HttpStatusCode)answer.Status);
            HttpContent content = answer.Body == null ? new ByteArrayContent(Array.Empty<byte>()) : new StreamContent(new SlowStream(Encoding.UTF8.GetBytes(answer.Body), answer.BodyDelayMs));
            foreach (var header in answer.Headers)
            {
                if (!response.Headers.TryAddWithoutValidation(header.Key, header.Value))
                {
                    content.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
            }
            response.Content = content;
            return response;
        }
    }

    internal sealed class SlowStream : MemoryStream
    {
        private int _delayMs;

        public SlowStream(byte[] bytes, int delayMs)
            : base(bytes)
        {
            _delayMs = delayMs;
        }

        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            if (_delayMs > 0)
            {
                var delay = _delayMs;
                _delayMs = 0;
                await Task.Delay(delay, cancellationToken);
            }
            return await base.ReadAsync(buffer, offset, count, cancellationToken);
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_delayMs > 0)
            {
                var delay = _delayMs;
                _delayMs = 0;
                await Task.Delay(delay, cancellationToken);
            }
            return await base.ReadAsync(buffer, cancellationToken);
        }
    }

    public sealed class PipelineTests
    {
        public static IEnumerable<object[]> ServeCases() => Fixtures.Indexes("serve");
        public static IEnumerable<object[]> RecordCases() => Fixtures.Indexes("record");

        private static RelayRequest ToRequest(JsonElement request, string? ip)
        {
            var url = new Uri(request.GetProperty("url").GetString()!);
            var host = url.IsDefaultPort ? url.Host : url.Host + ":" + url.Port;
            var headers = Fixtures.Headers(request.GetProperty("headers"));
            var body = Fixtures.String(request, "body");
            return new RelayRequest(request.GetProperty("method").GetString()!, host, url.AbsolutePath, url.Query.TrimStart('?'), headers, ip ?? string.Empty)
            {
                ReadBody = (maxBytes, deadline) =>
                {
                    var bytes = Encoding.UTF8.GetBytes(body ?? string.Empty);
                    return Task.FromResult<byte[]?>(bytes.Length > maxBytes ? null : bytes);
                },
            };
        }

        [Theory]
        [MemberData(nameof(ServeCases))]
        public async Task Serve(int index)
        {
            var item = Fixtures.Load("serve", out var relayVersion)[index];
            var apiUrl = item.GetProperty("apiUrl").GetString()!;
            var token = item.GetProperty("ingestToken").GetString()!;
            var handler = new FakeHandler();
            handler.Exact[apiUrl + "/api/v2/agent-traffic/serve/" + token + "/rules"] = FakeAnswer.From(item.GetProperty("siteRules"));
            var pageService = item.GetProperty("pageService");
            handler.Prefixes.Add(("https://pages.test/serve/tok/pages", pageService.ValueKind == JsonValueKind.Null ? null : FakeAnswer.From(pageService)));
            var relay = new Relay(new RelayOptions { AgentTrafficKey = "wwt_" + token + ".b3JnLWtleQ", BaseUrl = apiUrl, Rules = "bundled" }, "aspnet", new HttpClient(handler), new SystemClock(), relayVersion);
            var request = item.GetProperty("request");
            var answer = await relay.ServeAgentPageAsync(ToRequest(request, Fixtures.String(request, "ip")));

            var expected = item.GetProperty("expected");
            var expectedAnswer = expected.GetProperty("answer");
            var name = item.GetProperty("name").GetString();
            if (expectedAnswer.ValueKind == JsonValueKind.Null)
            {
                Assert.True(answer == null, $"{name}: expected null, got {answer?.Status}");
            }
            else
            {
                Assert.True(answer != null, $"{name}: expected {expectedAnswer.GetProperty("status")}, got null");
                Assert.Equal(expectedAnswer.GetProperty("status").GetInt32(), answer!.Status);
                var expectedHeaders = Fixtures.Headers(expectedAnswer.GetProperty("headers"));
                var actualHeaders = answer.Headers.ToDictionary(pair => pair.Key, pair => pair.Value);
                Assert.Equal(expectedHeaders.OrderBy(pair => pair.Key), actualHeaders.OrderBy(pair => pair.Key));
                var expectedBody = Fixtures.String(expectedAnswer, "body");
                Assert.Equal(expectedBody, answer.Body == null ? null : Encoding.UTF8.GetString(answer.Body));
            }

            var expectedPage = expected.GetProperty("pageRequest");
            var pageRequests = handler.Seen.Where(seen => seen.Url.StartsWith("https://pages.test/", StringComparison.Ordinal)).ToList();
            if (expectedPage.ValueKind == JsonValueKind.Null)
            {
                Assert.Empty(pageRequests);
                return;
            }
            var sent = Assert.Single(pageRequests);
            Assert.Equal(expectedPage.GetProperty("url").GetString(), sent.Url);
            Assert.Equal(expectedPage.GetProperty("method").GetString(), sent.Method);
            Assert.Equal(Fixtures.String(expectedPage, "body"), sent.Body);
            var expectedPageHeaders = Fixtures.Headers(expectedPage.GetProperty("headers"));
            foreach (var header in expectedPageHeaders)
            {
                Assert.True(sent.Headers.TryGetValue(header.Key, out var value) && value == header.Value, $"{name}: page request header {header.Key} is {value}, expected {header.Value}");
            }
            Assert.Empty(sent.Headers.Keys.Except(expectedPageHeaders.Keys).Except(new[] { "content-length" }));
        }

        [Theory]
        [MemberData(nameof(RecordCases))]
        public async Task Record(int index)
        {
            var item = Fixtures.Load("record", out var relayVersion)[index];
            var handler = new FakeHandler();
            handler.Prefixes.Add(("https://api.test/", new FakeAnswer { Status = 202 }));
            var omit = item.TryGetProperty("omit", out var omitElement) ? omitElement.EnumerateArray().Select(entry => entry.GetString()!).ToList() : new List<string>();
            var options = new RelayOptions { AgentTrafficKey = Fixtures.String(item, "key") ?? string.Empty, BaseUrl = item.GetProperty("apiUrl").GetString(), Omit = omit, Rules = "bundled" };
            var relay = new Relay(options, "aspnet", new HttpClient(handler), new SystemClock(), relayVersion);
            var request = item.GetProperty("request");
            relay.RecordAgentVisit(ToRequest(request, Fixtures.String(request, "ip")));
            await relay.ShutdownAsync(TimeSpan.FromSeconds(5));

            var expected = item.GetProperty("expected");
            var posts = handler.Seen.ToList();
            if (expected.ValueKind == JsonValueKind.Null)
            {
                Assert.Empty(posts);
                return;
            }
            var post = Assert.Single(posts);
            Assert.Equal(expected.GetProperty("url").GetString(), post.Url);
            using var body = JsonDocument.Parse(post.Body!);
            var record = Assert.Single(body.RootElement.GetProperty("requests").EnumerateArray().ToList());
            Assert.Equal("aspnet", record.GetProperty("platform").GetString());
            Assert.True(DateTime.TryParse(record.GetProperty("occurredAt").GetString(), out _));
            Assert.True(Guid.TryParse(record.GetProperty("sourceEventId").GetString(), out _));
            Assert.Equal(new[] { "recordAgentVisit" }, record.GetProperty("uses").EnumerateArray().Select(use => use.GetString()));
            var trimmed = new Dictionary<string, JsonElement>();
            foreach (var property in record.EnumerateObject())
            {
                if (property.Name is not ("occurredAt" or "sourceEventId" or "uses" or "platform"))
                {
                    trimmed[property.Name] = property.Value;
                }
            }
            using var actual = JsonDocument.Parse(JsonSerializer.Serialize(trimmed));
            Assert.True(Fixtures.JsonEquals(expected.GetProperty("record"), actual.RootElement), $"{item.GetProperty("name")}: {JsonSerializer.Serialize(trimmed)}");
        }
    }
}
