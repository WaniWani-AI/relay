using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Waniwani.Relay
{
    internal static class Json
    {
        public static bool IsNumber(JsonValue element, string name, double value)
        {
            var property = element.Get(name);
            return property != null && property.Kind == JsonKind.Number && property.Number == value;
        }

        public static bool TryStringArray(JsonValue element, string name, out List<string> values)
        {
            values = new List<string>();
            var property = element.Get(name);
            return property != null && TryStringArray(property, out values);
        }

        public static bool TryStringArray(JsonValue property, out List<string> values)
        {
            values = new List<string>();
            if (property.Kind != JsonKind.Array)
            {
                return false;
            }
            foreach (var item in property.Items)
            {
                if (item.Kind != JsonKind.String)
                {
                    return false;
                }
                values.Add(item.String);
            }
            return true;
        }

        public static bool TryPositive(JsonValue element, string name, out double value)
        {
            value = 0;
            var property = element.Get(name);
            return property != null && TryPositive(property, out value);
        }

        public static bool TryPositive(JsonValue property, out double value)
        {
            value = property.Kind == JsonKind.Number ? property.Number : 0;
            return property.Kind == JsonKind.Number && !double.IsInfinity(value) && !double.IsNaN(value) && value > 0;
        }
    }

    internal static class JsNumber
    {
        private static readonly Regex Decimal = new Regex(@"^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$", RegexOptions.CultureInvariant);

        /// <summary>The value of JavaScript <c>Number(text)</c>.</summary>
        public static double Parse(string? text)
        {
            if (text == null)
            {
                return double.NaN;
            }
            var value = Text.TrimJs(text);
            if (value.Length == 0)
            {
                return 0;
            }
            switch (value)
            {
                case "Infinity":
                case "+Infinity":
                    return double.PositiveInfinity;
                case "-Infinity":
                    return double.NegativeInfinity;
            }
            if (value.Length > 2 && value[0] == '0')
            {
                var radix = char.ToLowerInvariant(value[1]) switch
                {
                    'x' => 16,
                    'o' => 8,
                    'b' => 2,
                    _ => 0,
                };
                if (radix != 0)
                {
                    double result = 0;
                    foreach (var c in value.Substring(2))
                    {
                        var digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'z' ? c - 'a' + 10 : c >= 'A' && c <= 'Z' ? c - 'A' + 10 : 99;
                        if (digit >= radix)
                        {
                            return double.NaN;
                        }
                        result = result * radix + digit;
                    }
                    return result;
                }
            }
            if (!Decimal.IsMatch(value))
            {
                return double.NaN;
            }
            return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : double.NaN;
        }
    }

    internal static class CappedHeaders
    {
        public static readonly string[] Names =
        {
            "user-agent", "referer", "accept", "accept-language", "from", "signature-agent", "signature-input", "signature", "dpop", "sec-ch-ua",
            "sec-ch-ua-platform", "sec-ch-ua-mobile", "authorization",
        };

        private static readonly Dictionary<string, string> KnownSchemes = new[]
        {
            "Basic", "Bearer", "Digest", "DPoP", "HOBA", "Mutual", "Negotiate", "NTLM", "OAuth", "PrivateToken", "SCRAM-SHA-1", "SCRAM-SHA-256", "vapid",
            "AWS4-HMAC-SHA256",
        }.ToDictionary(scheme => scheme.ToLowerInvariant(), scheme => scheme, StringComparer.Ordinal);

        private static readonly char[] Spaces = { ' ', '\t', '\n', '\r', '\f', '\v' };

        public static string? AuthorizationScheme(string value)
        {
            var parts = Text.TrimJs(value).Split(Spaces, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            {
                return null;
            }
            return KnownSchemes.TryGetValue(Text.ToLowerJs(parts[0]), out var scheme) ? scheme : null;
        }

        public static Dictionary<string, string> Read(IReadOnlyDictionary<string, string> headers)
        {
            var output = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var name in Names)
            {
                if (!headers.TryGetValue(name, out var value))
                {
                    continue;
                }
                if (name == "authorization")
                {
                    var scheme = AuthorizationScheme(value);
                    if (scheme != null)
                    {
                        output[name] = scheme;
                    }
                }
                else
                {
                    output[name] = value;
                }
            }
            return output;
        }
    }

    /// <summary>A parsed <c>wwt_</c> key.</summary>
    internal sealed class RelayKey
    {
        private static readonly Regex Pattern = new Regex(@"^wwt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+={0,2})$", RegexOptions.CultureInvariant);

        private RelayKey(string ingestToken, string orgKey)
        {
            IngestToken = ingestToken;
            OrgKey = orgKey;
        }

        public string IngestToken { get; }
        public string OrgKey { get; }

        public static RelayKey? Parse(string? raw)
        {
            if (raw == null)
            {
                return null;
            }
            var trimmed = Text.TrimJs(raw);
            if (trimmed.Length == 0)
            {
                return null;
            }
            var match = Pattern.Match(trimmed);
            if (!match.Success || match.Index != 0 || match.Length != trimmed.Length)
            {
                return null;
            }
            return new RelayKey(match.Groups[1].Value, match.Groups[2].Value);
        }
    }

    internal static class MatchKey
    {
        public static string Derive(string orgKey, string ip)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(orgKey)))
            {
                var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(ip));
                var builder = new StringBuilder(hash.Length * 2);
                foreach (var b in hash)
                {
                    builder.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }
    }

    internal static class ClientIp
    {
        public static string? ParseAddress(string entry)
        {
            var value = Text.ToLowerJs(Text.TrimJs(entry));
            if (value.Length > 0 && value[0] == '[')
            {
                var close = value.IndexOf(']');
                if (close > 1 && (close == value.Length - 1 || IsPortSuffix(value, close + 1)))
                {
                    value = value.Substring(1, close - 1);
                }
            }
            else
            {
                var colon = value.IndexOf(':');
                if (colon > 0 && colon == value.LastIndexOf(':') && IsDottedDigits(value, colon) && IsPortSuffix(value, colon))
                {
                    value = value.Substring(0, colon);
                }
            }
            return IpAddresses.TryParse(value, out _) ? value : null;
        }

        private static bool IsPortSuffix(string value, int colon)
        {
            if (colon >= value.Length - 1 || value[colon] != ':')
            {
                return false;
            }
            for (var i = colon + 1; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsDottedDigits(string value, int end)
        {
            for (var i = 0; i < end; i++)
            {
                if ((value[i] < '0' || value[i] > '9') && value[i] != '.')
                {
                    return false;
                }
            }
            return true;
        }

        public static IpRangeSet ProxyList(IEnumerable<string> entries)
        {
            var v4 = new List<string>();
            var v6 = new List<string>();
            foreach (var entry in entries)
            {
                var value = Text.ToLowerJs(Text.TrimJs(entry));
                var parts = value.Split('/');
                if (parts.Length > 2 || !IpAddresses.TryParse(parts[0], out var ip))
                {
                    throw new FormatException("malformed proxy " + entry);
                }
                var cidr = parts.Length == 2 ? value : value + (ip.IsV6 ? "/128" : "/32");
                (ip.IsV6 ? v6 : v4).Add(cidr);
            }
            return IpRangeSet.Build(v4, v6);
        }

        /// <summary>The visitor IP for a server behind proxies. See PROTOCOL.md.</summary>
        public static string? Resolve(string remoteAddress, IReadOnlyDictionary<string, string> headers, string? clientIpHeader, IpRangeSet trusted)
        {
            var remote = ParseAddress(remoteAddress);
            if (remote == null)
            {
                return null;
            }
            if (clientIpHeader == null || !trusted.Contains(remote))
            {
                return remote;
            }
            if (!headers.TryGetValue(Text.ToLowerJs(clientIpHeader), out var value) || Text.TrimJs(value).Length == 0)
            {
                return remote;
            }
            var entries = value.Split(',');
            var leftmost = remote;
            for (var index = entries.Length - 1; index >= 0; index--)
            {
                var address = ParseAddress(entries[index]);
                if (address == null)
                {
                    return leftmost;
                }
                if (!trusted.Contains(address))
                {
                    return address;
                }
                leftmost = address;
            }
            return leftmost;
        }
    }

    internal enum PageFormat
    {
        Html,
        Markdown,
    }

    internal static class Accept
    {
        private readonly struct MediaRange
        {
            public MediaRange(string type, double q)
            {
                Type = type;
                Q = q;
            }

            public string Type { get; }
            public double Q { get; }
        }

        private static List<MediaRange> Ranges(string accept)
        {
            var ranges = new List<MediaRange>();
            foreach (var range in accept.Split(','))
            {
                var parts = range.Split(';').Select(part => Text.ToLowerJs(Text.TrimJs(part))).ToArray();
                var type = parts.Length > 0 ? parts[0] : string.Empty;
                double value = 1;
                for (var i = 1; i < parts.Length; i++)
                {
                    var pieces = parts[i].Split('=').Select(Text.TrimJs).ToArray();
                    if (pieces[0] == "q")
                    {
                        value = JsNumber.Parse(pieces.Length > 1 ? pieces[1] : null);
                        break;
                    }
                }
                ranges.Add(new MediaRange(type, double.IsInfinity(value) || double.IsNaN(value) ? 0 : value));
            }
            return ranges;
        }

        private static double? QualityOf(List<MediaRange> ranges, string type)
        {
            double? best = null;
            foreach (var range in ranges)
            {
                if (range.Type == type && (best == null || range.Q > best.Value))
                {
                    best = range.Q;
                }
            }
            return best;
        }

        private static bool NamesMarkdown(string accept)
        {
            return accept.IndexOf("markdown", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static PageFormat PageFormatOf(string accept)
        {
            if (!NamesMarkdown(accept))
            {
                return PageFormat.Html;
            }
            return (QualityOf(Ranges(accept), "text/markdown") ?? 0) > 0 ? PageFormat.Markdown : PageFormat.Html;
        }

        public static bool PrefersMarkdown(string accept)
        {
            if (!NamesMarkdown(accept))
            {
                return false;
            }
            var ranges = Ranges(accept);
            var markdown = QualityOf(ranges, "text/markdown") ?? 0;
            var html = QualityOf(ranges, "text/html") ?? QualityOf(ranges, "text/*") ?? QualityOf(ranges, "*/*") ?? 0;
            return markdown > 0 && markdown >= html;
        }
    }

    internal static class Paths
    {
        public static string Normalize(string pathname)
        {
            var trimmed = pathname.TrimEnd('/');
            return trimmed.Length == 0 ? "/" : trimmed;
        }

        public static bool Matches(string path, IReadOnlyList<string> patterns)
        {
            foreach (var pattern in patterns)
            {
                if (pattern == "*" || pattern == "/*")
                {
                    return true;
                }
                if (pattern.EndsWith("/*", StringComparison.Ordinal))
                {
                    var folder = Normalize(pattern.Substring(0, pattern.Length - 2));
                    if (path == folder || path.StartsWith(folder + "/", StringComparison.Ordinal))
                    {
                        return true;
                    }
                    continue;
                }
                if (path == Normalize(pattern))
                {
                    return true;
                }
            }
            return false;
        }
    }

    internal static class HostName
    {
        /// <summary>The lowercase hostname in a <c>host</c> header, without the port, or null when the value holds more than a host and a port.</summary>
        public static string? Of(string? host)
        {
            if (string.IsNullOrEmpty(host))
            {
                return null;
            }
            var value = host!;
            if (value.IndexOfAny(new[] { '/', '?', '#', '@', ' ', '\\' }) >= 0)
            {
                return null;
            }
            if (value.StartsWith("[", StringComparison.Ordinal))
            {
                var end = value.IndexOf(']');
                if (end < 0)
                {
                    return null;
                }
                var rest = value.Substring(end + 1);
                if (rest.Length > 0 && !IsPort(rest))
                {
                    return null;
                }
                return Text.ToLowerJs(value.Substring(0, end + 1));
            }
            var colon = value.IndexOf(':');
            if (colon >= 0)
            {
                if (!IsPort(value.Substring(colon)))
                {
                    return null;
                }
                value = value.Substring(0, colon);
            }
            return value.Length == 0 ? null : Text.ToLowerJs(value);
        }

        private static bool IsPort(string text)
        {
            if (text.Length < 1 || text[0] != ':')
            {
                return false;
            }
            for (var i = 1; i < text.Length; i++)
            {
                if (text[i] < '0' || text[i] > '9')
                {
                    return false;
                }
            }
            return true;
        }
    }
}
