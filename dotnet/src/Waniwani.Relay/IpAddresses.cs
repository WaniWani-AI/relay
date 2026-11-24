using System;
using System.Collections.Generic;
using System.Globalization;

namespace Waniwani.Relay
{
    internal readonly struct ParsedIp
    {
        public ParsedIp(bool isV6, ulong high, ulong low)
        {
            IsV6 = isV6;
            High = high;
            Low = low;
        }

        public bool IsV6 { get; }
        public ulong High { get; }
        public ulong Low { get; }

        public bool IsV4Mapped => IsV6 && High == 0 && (Low >> 32) == 0xffff;

        public uint MappedV4 => (uint)(Low & 0xffffffff);
    }

    internal static class IpAddresses
    {
        public static bool TryParse(string text, out ParsedIp ip)
        {
            ip = default;
            if (text.IndexOf(':') >= 0)
            {
                if (!TryParseV6(text, out var high, out var low))
                {
                    return false;
                }
                ip = new ParsedIp(true, high, low);
                return true;
            }
            if (!TryParseV4(text, out var value))
            {
                return false;
            }
            ip = new ParsedIp(false, 0, value);
            return true;
        }

        public static bool TryParseV4(string text, out uint value)
        {
            value = 0;
            var parts = text.Split('.');
            if (parts.Length != 4)
            {
                return false;
            }
            foreach (var part in parts)
            {
                if (part.Length == 0 || part.Length > 3 || (part.Length > 1 && part[0] == '0'))
                {
                    return false;
                }
                var octet = 0;
                foreach (var c in part)
                {
                    if (c < '0' || c > '9')
                    {
                        return false;
                    }
                    octet = octet * 10 + (c - '0');
                }
                if (octet > 255)
                {
                    return false;
                }
                value = (value << 8) | (uint)octet;
            }
            return true;
        }

        public static bool TryParseV6(string text, out ulong high, out ulong low)
        {
            high = 0;
            low = 0;
            if (text.Length == 0 || text.IndexOf('%') >= 0)
            {
                return false;
            }
            var groups = new List<ushort>(8);
            var tail = new List<ushort>(8);
            var doubleColon = text.IndexOf("::", StringComparison.Ordinal);
            if (doubleColon >= 0 && text.IndexOf("::", doubleColon + 1, StringComparison.Ordinal) >= 0)
            {
                return false;
            }
            string head;
            string? rest;
            if (doubleColon >= 0)
            {
                head = text.Substring(0, doubleColon);
                rest = text.Substring(doubleColon + 2);
            }
            else
            {
                head = text;
                rest = null;
            }
            if (!ParseGroups(head, groups, rest == null))
            {
                return false;
            }
            if (rest != null && !ParseGroups(rest, tail, true))
            {
                return false;
            }
            var count = groups.Count + tail.Count;
            if (rest == null && count != 8)
            {
                return false;
            }
            if (rest != null && count > 7)
            {
                return false;
            }
            var all = new ushort[8];
            for (var i = 0; i < groups.Count; i++)
            {
                all[i] = groups[i];
            }
            for (var i = 0; i < tail.Count; i++)
            {
                all[8 - tail.Count + i] = tail[i];
            }
            for (var i = 0; i < 4; i++)
            {
                high = (high << 16) | all[i];
                low = (low << 16) | all[i + 4];
            }
            return true;
        }

        private static bool ParseGroups(string text, List<ushort> into, bool allowV4Tail)
        {
            if (text.Length == 0)
            {
                return true;
            }
            var parts = text.Split(':');
            for (var i = 0; i < parts.Length; i++)
            {
                var part = parts[i];
                if (i == parts.Length - 1 && allowV4Tail && part.IndexOf('.') >= 0)
                {
                    if (!TryParseV4(part, out var v4))
                    {
                        return false;
                    }
                    into.Add((ushort)(v4 >> 16));
                    into.Add((ushort)(v4 & 0xffff));
                    continue;
                }
                if (part.Length == 0 || part.Length > 4)
                {
                    return false;
                }
                if (!ushort.TryParse(part, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var group))
                {
                    return false;
                }
                into.Add(group);
            }
            return into.Count <= 8;
        }
    }

    internal sealed class IpRangeSet
    {
        private readonly uint[] _v4Starts;
        private readonly uint[] _v4Ends;
        private readonly Range128[] _v6;

        private IpRangeSet(uint[] v4Starts, uint[] v4Ends, Range128[] v6)
        {
            _v4Starts = v4Starts;
            _v4Ends = v4Ends;
            _v6 = v6;
        }

        public static IpRangeSet Empty { get; } = new IpRangeSet(Array.Empty<uint>(), Array.Empty<uint>(), Array.Empty<Range128>());

        public static IpRangeSet Build(IEnumerable<string> v4Cidrs, IEnumerable<string> v6Cidrs)
        {
            var v4 = new List<KeyValuePair<uint, uint>>();
            foreach (var cidr in v4Cidrs)
            {
                var address = SplitCidr(cidr, 32, out var prefix);
                if (!IpAddresses.TryParseV4(address, out var value))
                {
                    throw new FormatException("malformed range " + cidr);
                }
                var mask = prefix == 0 ? 0u : uint.MaxValue << (32 - prefix);
                var start = value & mask;
                v4.Add(new KeyValuePair<uint, uint>(start, start | ~mask));
            }
            var v6 = new List<Range128>();
            foreach (var cidr in v6Cidrs)
            {
                var address = SplitCidr(cidr, 128, out var prefix);
                if (!IpAddresses.TryParseV6(address, out var high, out var low))
                {
                    throw new FormatException("malformed range " + cidr);
                }
                v6.Add(Range128.FromPrefix(high, low, prefix));
            }
            v4.Sort((a, b) => a.Key.CompareTo(b.Key));
            var starts = new List<uint>();
            var ends = new List<uint>();
            foreach (var range in v4)
            {
                if (starts.Count > 0 && (ulong)range.Key <= (ulong)ends[ends.Count - 1] + 1)
                {
                    if (range.Value > ends[ends.Count - 1])
                    {
                        ends[ends.Count - 1] = range.Value;
                    }
                    continue;
                }
                starts.Add(range.Key);
                ends.Add(range.Value);
            }
            v6.Sort((a, b) => a.CompareStart(b));
            return new IpRangeSet(starts.ToArray(), ends.ToArray(), v6.ToArray());
        }

        private static string SplitCidr(string cidr, int max, out int prefix)
        {
            var parts = cidr.Split('/');
            if (parts.Length != 2 || parts[1].Length == 0 || parts[1].Length > 3)
            {
                throw new FormatException("malformed range " + cidr);
            }
            foreach (var c in parts[1])
            {
                if (c < '0' || c > '9')
                {
                    throw new FormatException("malformed range " + cidr);
                }
            }
            prefix = int.Parse(parts[1], CultureInfo.InvariantCulture);
            if (prefix > max)
            {
                throw new FormatException("malformed range " + cidr);
            }
            return parts[0];
        }

        public bool Contains(ParsedIp ip)
        {
            if (!ip.IsV6)
            {
                return ContainsV4((uint)ip.Low);
            }
            if (ip.IsV4Mapped && ContainsV4(ip.MappedV4))
            {
                return true;
            }
            foreach (var range in _v6)
            {
                if (range.Contains(ip.High, ip.Low))
                {
                    return true;
                }
            }
            return false;
        }

        public bool Contains(string address)
        {
            return IpAddresses.TryParse(address, out var ip) && Contains(ip);
        }

        private bool ContainsV4(uint value)
        {
            var lo = 0;
            var hi = _v4Starts.Length - 1;
            while (lo <= hi)
            {
                var mid = (lo + hi) >> 1;
                if (_v4Starts[mid] <= value)
                {
                    if (value <= _v4Ends[mid])
                    {
                        return true;
                    }
                    lo = mid + 1;
                }
                else
                {
                    hi = mid - 1;
                }
            }
            return false;
        }

        private readonly struct Range128
        {
            private readonly ulong _startHigh;
            private readonly ulong _startLow;
            private readonly ulong _endHigh;
            private readonly ulong _endLow;

            private Range128(ulong startHigh, ulong startLow, ulong endHigh, ulong endLow)
            {
                _startHigh = startHigh;
                _startLow = startLow;
                _endHigh = endHigh;
                _endLow = endLow;
            }

            public static Range128 FromPrefix(ulong high, ulong low, int prefix)
            {
                ulong highMask;
                ulong lowMask;
                if (prefix >= 64)
                {
                    highMask = ulong.MaxValue;
                    lowMask = prefix == 64 ? 0 : ulong.MaxValue << (128 - prefix);
                }
                else
                {
                    highMask = prefix == 0 ? 0 : ulong.MaxValue << (64 - prefix);
                    lowMask = 0;
                }
                return new Range128(high & highMask, low & lowMask, (high & highMask) | ~highMask, (low & lowMask) | ~lowMask);
            }

            public int CompareStart(Range128 other)
            {
                var high = _startHigh.CompareTo(other._startHigh);
                return high != 0 ? high : _startLow.CompareTo(other._startLow);
            }

            public bool Contains(ulong high, ulong low)
            {
                var afterStart = high > _startHigh || (high == _startHigh && low >= _startLow);
                var beforeEnd = high < _endHigh || (high == _endHigh && low <= _endLow);
                return afterStart && beforeEnd;
            }
        }
    }
}
