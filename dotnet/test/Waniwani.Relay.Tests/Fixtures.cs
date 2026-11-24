using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Waniwani.Relay.Tests
{
    internal static class Fixtures
    {
        public static JsonElement Load(string name, out string relayVersion)
        {
            var path = Path.Combine(AppContext.BaseDirectory, "fixtures", name + ".json");
            var document = JsonDocument.Parse(File.ReadAllText(path));
            relayVersion = document.RootElement.GetProperty("relayVersion").GetString()!;
            return document.RootElement.GetProperty("cases");
        }

        public static IEnumerable<object[]> Indexes(string name)
        {
            var cases = Load(name, out _);
            return Enumerable.Range(0, cases.GetArrayLength()).Select(index => new object[] { index });
        }

        public static Dictionary<string, string> Headers(JsonElement element)
        {
            var headers = new Dictionary<string, string>(StringComparer.Ordinal);
            if (element.ValueKind != JsonValueKind.Object)
            {
                return headers;
            }
            foreach (var property in element.EnumerateObject())
            {
                headers[property.Name.ToLowerInvariant()] = property.Value.GetString()!;
            }
            return headers;
        }

        public static string? String(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        }

        public static bool JsonEquals(JsonElement left, JsonElement right)
        {
            if (left.ValueKind != right.ValueKind)
            {
                return false;
            }
            switch (left.ValueKind)
            {
                case JsonValueKind.Object:
                    var leftProperties = left.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    var rightProperties = right.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    return leftProperties.Count == rightProperties.Count && leftProperties.All(pair => rightProperties.TryGetValue(pair.Key, out var other) && JsonEquals(pair.Value, other));
                case JsonValueKind.Array:
                    var leftItems = left.EnumerateArray().ToList();
                    var rightItems = right.EnumerateArray().ToList();
                    return leftItems.Count == rightItems.Count && leftItems.Zip(rightItems).All(pair => JsonEquals(pair.First, pair.Second));
                case JsonValueKind.Number:
                    return left.GetDouble() == right.GetDouble();
                case JsonValueKind.String:
                    return left.GetString() == right.GetString();
                default:
                    return true;
            }
        }
    }
}
