using System;
using System.Collections.Generic;
using System.IO;

namespace Waniwani.Relay
{
    internal sealed class AgentRules
    {
        private const int MaxScannedUserAgent = 1024;
        private const int Prefix = 3;

        private readonly Dictionary<string, string[]> _tokensByPrefix;
        private readonly IpRangeSet _ranges;

        private AgentRules(Dictionary<string, string[]> tokensByPrefix, IpRangeSet ranges)
        {
            _tokensByPrefix = tokensByPrefix;
            _ranges = ranges;
        }

        public static AgentRules Compile(IReadOnlyList<string> tokens, IReadOnlyList<RangeSource> ranges)
        {
            var grouped = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var token in tokens)
            {
                var key = token.Length >= Prefix ? token.Substring(0, Prefix) : token;
                if (!grouped.TryGetValue(key, out var list))
                {
                    list = new List<string>();
                    grouped[key] = list;
                }
                list.Add(token);
            }
            var byPrefix = new Dictionary<string, string[]>(StringComparer.Ordinal);
            foreach (var pair in grouped)
            {
                byPrefix[pair.Key] = pair.Value.ToArray();
            }
            var v4 = new List<string>();
            var v6 = new List<string>();
            foreach (var source in ranges)
            {
                v4.AddRange(source.V4);
                v6.AddRange(source.V6);
            }
            return new AgentRules(byPrefix, IpRangeSet.Build(v4, v6));
        }

        public static AgentRules LoadBundled()
        {
            var tokens = new List<string>();
            foreach (var token in ReadResource("Waniwani.Relay.agents.json").Get("tokens")?.Items ?? new List<JsonValue>())
            {
                tokens.Add(token.String);
            }
            var ranges = new List<RangeSource>();
            foreach (var source in ReadResource("Waniwani.Relay.ip-ranges.json").Get("sources")?.Items ?? new List<JsonValue>())
            {
                Json.TryStringArray(source, "ipv4", out var v4);
                Json.TryStringArray(source, "ipv6", out var v6);
                ranges.Add(new RangeSource(v4, v6));
            }
            return Compile(tokens, ranges);
        }

        private static JsonValue ReadResource(string name)
        {
            using (var stream = typeof(AgentRules).Assembly.GetManifestResourceStream(name) ?? throw new InvalidOperationException("missing " + name))
            using (var reader = new StreamReader(stream))
            {
                return JsonValue.Parse(reader.ReadToEnd());
            }
        }

        /// <summary>The match rules in the <c>data</c> of the agent rules answer, or null when it does not have the expected form. Throws when a range is malformed.</summary>
        public static AgentRules? ParseRemote(JsonValue data)
        {
            if (data.Kind != JsonKind.Object || !Json.IsNumber(data, "version", 1))
            {
                return null;
            }
            var ipRanges = data.Get("ipRanges");
            if (!Json.TryStringArray(data, "tokens", out var tokens) || ipRanges == null || ipRanges.Kind != JsonKind.Array)
            {
                return null;
            }
            var ranges = new List<RangeSource>();
            foreach (var range in ipRanges.Items)
            {
                if (range.Kind != JsonKind.Object || !Json.TryStringArray(range, "ipv4", out var v4) || !Json.TryStringArray(range, "ipv6", out var v6))
                {
                    return null;
                }
                ranges.Add(new RangeSource(v4, v6));
            }
            var lowered = new List<string>(tokens.Count);
            foreach (var token in tokens)
            {
                lowered.Add(Text.ToLowerJs(token));
            }
            return Compile(lowered, ranges);
        }

        public bool HasAgentToken(string userAgent)
        {
            var scanned = userAgent.Length > MaxScannedUserAgent ? userAgent.Substring(0, MaxScannedUserAgent) : userAgent;
            var text = Text.ToLowerJs(scanned);
            for (var i = 0; i + Prefix <= text.Length; i++)
            {
                if (_tokensByPrefix.TryGetValue(text.Substring(i, Prefix), out var candidates))
                {
                    foreach (var token in candidates)
                    {
                        if (i + token.Length <= text.Length && string.CompareOrdinal(text, i, token, 0, token.Length) == 0)
                        {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        public bool IsAgentIp(string ip)
        {
            return _ranges.Contains(ip);
        }

        public bool Decide(IReadOnlyDictionary<string, string> cappedHeaders, string? ip)
        {
            if (cappedHeaders.TryGetValue("user-agent", out var userAgent) && HasAgentToken(userAgent))
            {
                return true;
            }
            if (cappedHeaders.ContainsKey("signature-agent") || cappedHeaders.ContainsKey("dpop"))
            {
                return true;
            }
            if (cappedHeaders.TryGetValue("authorization", out var authorization) && string.Equals(Text.ToLowerJs(authorization), "dpop", StringComparison.Ordinal))
            {
                return true;
            }
            return ip != null && IsAgentIp(ip);
        }
    }

    internal sealed class RangeSource
    {
        public RangeSource(IReadOnlyList<string> v4, IReadOnlyList<string> v6)
        {
            V4 = v4;
            V6 = v6;
        }

        public IReadOnlyList<string> V4 { get; }
        public IReadOnlyList<string> V6 { get; }
    }

    internal static class Text
    {
        public static string ToLowerJs(string value)
        {
            return value.ToLowerInvariant();
        }

        public static string TrimJs(string value)
        {
            return value.Trim(WhiteSpace);
        }

        private static readonly char[] WhiteSpace =
        {
            '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
            ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿',
        };
    }
}
