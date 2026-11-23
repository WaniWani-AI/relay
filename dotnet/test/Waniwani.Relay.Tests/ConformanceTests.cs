using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Waniwani.Relay.Tests
{
    public sealed class ConformanceTests
    {
        private static readonly AgentRules Bundled = AgentRules.LoadBundled();

        public static IEnumerable<object[]> DecideCases() => Fixtures.Indexes("decide");
        public static IEnumerable<object[]> HeaderCases() => Fixtures.Indexes("headers");
        public static IEnumerable<object[]> ClientIpCases() => Fixtures.Indexes("client-ip");
        public static IEnumerable<object[]> MatchKeyCases() => Fixtures.Indexes("match-key");
        public static IEnumerable<object[]> KeyCases() => Fixtures.Indexes("key");
        public static IEnumerable<object[]> AcceptCases() => Fixtures.Indexes("accept");
        public static IEnumerable<object[]> SiteRulesCases() => Fixtures.Indexes("site-rules");

        [Theory]
        [MemberData(nameof(DecideCases))]
        public void Decide(int index)
        {
            var item = Fixtures.Load("decide", out _)[index];
            var headers = CappedHeaders.Read(Fixtures.Headers(item.GetProperty("headers")));
            var ip = Fixtures.String(item, "ip");
            bool actual;
            try
            {
                actual = Bundled.Decide(headers, ip);
            }
            catch
            {
                actual = false;
            }
            Assert.True(item.GetProperty("expected").GetBoolean() == actual, $"decide {item}");
        }

        [Theory]
        [MemberData(nameof(HeaderCases))]
        public void Headers(int index)
        {
            var item = Fixtures.Load("headers", out _)[index];
            var actual = CappedHeaders.Read(Fixtures.Headers(item.GetProperty("headers")));
            var expected = Fixtures.Headers(item.GetProperty("expected"));
            Assert.Equal(expected.OrderBy(pair => pair.Key), actual.OrderBy(pair => pair.Key));
        }

        [Theory]
        [MemberData(nameof(ClientIpCases))]
        public void ClientIpRule(int index)
        {
            var item = Fixtures.Load("client-ip", out _)[index];
            var trusted = ClientIp.ProxyList(item.GetProperty("trustedProxies").EnumerateArray().Select(entry => entry.GetString()!));
            var header = Fixtures.String(item, "clientIpHeader");
            var actual = ClientIp.Resolve(item.GetProperty("remoteAddress").GetString()!, Fixtures.Headers(item.GetProperty("headers")), header?.ToLowerInvariant(), trusted);
            Assert.Equal(Fixtures.String(item, "expected"), actual);
        }

        [Theory]
        [MemberData(nameof(MatchKeyCases))]
        public void MatchKeys(int index)
        {
            var item = Fixtures.Load("match-key", out _)[index];
            Assert.Equal(item.GetProperty("expected").GetString(), MatchKey.Derive(item.GetProperty("orgKey").GetString()!, item.GetProperty("ip").GetString()!));
        }

        [Theory]
        [MemberData(nameof(KeyCases))]
        public void Keys(int index)
        {
            var item = Fixtures.Load("key", out _)[index];
            var actual = RelayKey.Parse(item.GetProperty("key").GetString());
            var expected = item.GetProperty("expected");
            if (expected.ValueKind == JsonValueKind.Null)
            {
                Assert.Null(actual);
                return;
            }
            Assert.NotNull(actual);
            Assert.Equal(expected.GetProperty("ingestToken").GetString(), actual!.IngestToken);
            Assert.Equal(expected.GetProperty("orgKey").GetString(), actual.OrgKey);
        }

        [Theory]
        [MemberData(nameof(AcceptCases))]
        public void AcceptNegotiation(int index)
        {
            var item = Fixtures.Load("accept", out _)[index];
            var accept = item.GetProperty("accept").GetString()!;
            Assert.Equal(item.GetProperty("pageFormat").GetString(), Accept.PageFormatOf(accept) == PageFormat.Markdown ? "markdown" : "html");
            Assert.Equal(item.GetProperty("prefersMarkdown").GetBoolean(), Accept.PrefersMarkdown(accept));
        }

        [Fact]
        public void PathRules()
        {
            var item = Fixtures.Load("paths", out _)[0];
            foreach (var normalize in item.GetProperty("normalize").EnumerateArray())
            {
                Assert.Equal(normalize.GetProperty("expected").GetString(), Paths.Normalize(normalize.GetProperty("path").GetString()!));
            }
            foreach (var match in item.GetProperty("matches").EnumerateArray())
            {
                var patterns = match.GetProperty("patterns").EnumerateArray().Select(pattern => pattern.GetString()!).ToList();
                var path = match.GetProperty("path").GetString()!;
                Assert.True(match.GetProperty("expected").GetBoolean() == Paths.Matches(path, patterns), $"{path} against {string.Join(",", patterns)}");
            }
        }

        [Theory]
        [MemberData(nameof(SiteRulesCases))]
        public void SiteRulesParse(int index)
        {
            var item = Fixtures.Load("site-rules", out _)[index];
            var parsed = SiteRules.Parse(JsonValue.Parse(item.GetProperty("input").GetRawText()));
            var expected = item.GetProperty("expected");
            if (expected.ValueKind == JsonValueKind.Null)
            {
                Assert.Null(parsed);
                return;
            }
            Assert.NotNull(parsed);
            using var actual = JsonDocument.Parse(parsed!.ToJson());
            Assert.True(Fixtures.JsonEquals(expected, actual.RootElement), $"{item.GetProperty("name")}: {parsed.ToJson()}");
        }
    }
}
