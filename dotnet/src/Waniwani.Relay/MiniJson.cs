using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Waniwani.Relay
{
    internal enum JsonKind
    {
        Null,
        False,
        True,
        Number,
        String,
        Array,
        Object,
    }

    /// <summary>A parsed JSON value. The package has no dependencies, so it can run in old ASP.NET sites without binding redirects.</summary>
    internal sealed class JsonValue
    {
        public static readonly JsonValue NullValue = new JsonValue(JsonKind.Null);

        private JsonValue(JsonKind kind)
        {
            Kind = kind;
        }

        public JsonKind Kind { get; }
        public double Number { get; private set; }
        public string String { get; private set; } = string.Empty;
        public List<JsonValue> Items { get; } = new List<JsonValue>();
        public Dictionary<string, JsonValue> Properties { get; } = new Dictionary<string, JsonValue>(StringComparer.Ordinal);

        public bool IsBoolean => Kind == JsonKind.True || Kind == JsonKind.False;

        public JsonValue? Get(string name)
        {
            return Kind == JsonKind.Object && Properties.TryGetValue(name, out var value) ? value : null;
        }

        public static JsonValue Parse(string text)
        {
            var parser = new Parser(text);
            var value = parser.ReadValue(0);
            parser.SkipWhiteSpace();
            if (!parser.AtEnd)
            {
                throw new FormatException("unexpected text after JSON");
            }
            return value;
        }

        private sealed class Parser
        {
            private const int MaxDepth = 64;
            private readonly string _text;
            private int _position;

            public Parser(string text)
            {
                _text = text;
            }

            public bool AtEnd => _position >= _text.Length;

            public void SkipWhiteSpace()
            {
                while (_position < _text.Length && (_text[_position] == ' ' || _text[_position] == '\t' || _text[_position] == '\n' || _text[_position] == '\r'))
                {
                    _position++;
                }
            }

            private char Peek()
            {
                if (_position >= _text.Length)
                {
                    throw new FormatException("unexpected end of JSON");
                }
                return _text[_position];
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(_text, _position, word, 0, word.Length) != 0)
                {
                    throw new FormatException("invalid JSON");
                }
                _position += word.Length;
            }

            public JsonValue ReadValue(int depth)
            {
                if (depth > MaxDepth)
                {
                    throw new FormatException("JSON too deep");
                }
                SkipWhiteSpace();
                var c = Peek();
                switch (c)
                {
                    case '{':
                        return ReadObject(depth);
                    case '[':
                        return ReadArray(depth);
                    case '"':
                        return new JsonValue(JsonKind.String) { String = ReadString() };
                    case 't':
                        Expect("true");
                        return new JsonValue(JsonKind.True);
                    case 'f':
                        Expect("false");
                        return new JsonValue(JsonKind.False);
                    case 'n':
                        Expect("null");
                        return NullValue;
                    default:
                        return new JsonValue(JsonKind.Number) { Number = ReadNumber() };
                }
            }

            private JsonValue ReadObject(int depth)
            {
                var value = new JsonValue(JsonKind.Object);
                _position++;
                SkipWhiteSpace();
                if (Peek() == '}')
                {
                    _position++;
                    return value;
                }
                while (true)
                {
                    SkipWhiteSpace();
                    if (Peek() != '"')
                    {
                        throw new FormatException("invalid JSON");
                    }
                    var name = ReadString();
                    SkipWhiteSpace();
                    if (Peek() != ':')
                    {
                        throw new FormatException("invalid JSON");
                    }
                    _position++;
                    value.Properties[name] = ReadValue(depth + 1);
                    SkipWhiteSpace();
                    var next = Peek();
                    _position++;
                    if (next == '}')
                    {
                        return value;
                    }
                    if (next != ',')
                    {
                        throw new FormatException("invalid JSON");
                    }
                }
            }

            private JsonValue ReadArray(int depth)
            {
                var value = new JsonValue(JsonKind.Array);
                _position++;
                SkipWhiteSpace();
                if (Peek() == ']')
                {
                    _position++;
                    return value;
                }
                while (true)
                {
                    value.Items.Add(ReadValue(depth + 1));
                    SkipWhiteSpace();
                    var next = Peek();
                    _position++;
                    if (next == ']')
                    {
                        return value;
                    }
                    if (next != ',')
                    {
                        throw new FormatException("invalid JSON");
                    }
                }
            }

            private string ReadString()
            {
                _position++;
                var builder = new StringBuilder();
                while (true)
                {
                    var c = Peek();
                    _position++;
                    if (c == '"')
                    {
                        return builder.ToString();
                    }
                    if (c < ' ')
                    {
                        throw new FormatException("invalid JSON string");
                    }
                    if (c != '\\')
                    {
                        builder.Append(c);
                        continue;
                    }
                    var escape = Peek();
                    _position++;
                    switch (escape)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            builder.Append(escape);
                            break;
                        case 'b':
                            builder.Append('\b');
                            break;
                        case 'f':
                            builder.Append('\f');
                            break;
                        case 'n':
                            builder.Append('\n');
                            break;
                        case 'r':
                            builder.Append('\r');
                            break;
                        case 't':
                            builder.Append('\t');
                            break;
                        case 'u':
                            if (_position + 4 > _text.Length)
                            {
                                throw new FormatException("invalid JSON escape");
                            }
                            builder.Append((char)int.Parse(_text.Substring(_position, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
                            _position += 4;
                            break;
                        default:
                            throw new FormatException("invalid JSON escape");
                    }
                }
            }

            private double ReadNumber()
            {
                var start = _position;
                if (_position < _text.Length && _text[_position] == '-')
                {
                    _position++;
                }
                var digits = 0;
                while (_position < _text.Length && char.IsDigit(_text[_position]) && _text[_position] <= '9')
                {
                    _position++;
                    digits++;
                }
                if (digits == 0)
                {
                    throw new FormatException("invalid JSON number");
                }
                if (_position < _text.Length && _text[_position] == '.')
                {
                    _position++;
                    var fraction = 0;
                    while (_position < _text.Length && _text[_position] >= '0' && _text[_position] <= '9')
                    {
                        _position++;
                        fraction++;
                    }
                    if (fraction == 0)
                    {
                        throw new FormatException("invalid JSON number");
                    }
                }
                if (_position < _text.Length && (_text[_position] == 'e' || _text[_position] == 'E'))
                {
                    _position++;
                    if (_position < _text.Length && (_text[_position] == '+' || _text[_position] == '-'))
                    {
                        _position++;
                    }
                    var exponent = 0;
                    while (_position < _text.Length && _text[_position] >= '0' && _text[_position] <= '9')
                    {
                        _position++;
                        exponent++;
                    }
                    if (exponent == 0)
                    {
                        throw new FormatException("invalid JSON number");
                    }
                }
                var text = _text.Substring(start, _position - start);
                return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : text.StartsWith("-", StringComparison.Ordinal) ? double.NegativeInfinity : double.PositiveInfinity;
            }
        }
    }

    internal sealed class JsonWriter
    {
        private readonly StringBuilder _builder = new StringBuilder();
        private readonly Stack<bool> _first = new Stack<bool>();

        public override string ToString()
        {
            return _builder.ToString();
        }

        private void Separator()
        {
            if (_first.Count == 0)
            {
                return;
            }
            if (_first.Peek())
            {
                _first.Pop();
                _first.Push(false);
            }
            else
            {
                _builder.Append(',');
            }
        }

        private void Name(string? name)
        {
            Separator();
            if (name != null)
            {
                Quote(name);
                _builder.Append(':');
            }
        }

        public JsonWriter StartObject(string? name = null)
        {
            Name(name);
            _builder.Append('{');
            _first.Push(true);
            return this;
        }

        public JsonWriter EndObject()
        {
            _first.Pop();
            _builder.Append('}');
            return this;
        }

        public JsonWriter StartArray(string? name = null)
        {
            Name(name);
            _builder.Append('[');
            _first.Push(true);
            return this;
        }

        public JsonWriter EndArray()
        {
            _first.Pop();
            _builder.Append(']');
            return this;
        }

        public JsonWriter String(string? name, string value)
        {
            Name(name);
            Quote(value);
            return this;
        }

        public JsonWriter Number(string? name, double value)
        {
            Name(name);
            _builder.Append(value.ToString("R", CultureInfo.InvariantCulture));
            return this;
        }

        public JsonWriter Boolean(string? name, bool value)
        {
            Name(name);
            _builder.Append(value ? "true" : "false");
            return this;
        }

        private void Quote(string value)
        {
            _builder.Append('"');
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"':
                        _builder.Append("\\\"");
                        break;
                    case '\\':
                        _builder.Append("\\\\");
                        break;
                    case '\n':
                        _builder.Append("\\n");
                        break;
                    case '\r':
                        _builder.Append("\\r");
                        break;
                    case '\t':
                        _builder.Append("\\t");
                        break;
                    default:
                        if (c < ' ' || (c >= '\uD800' && c <= '\uDFFF'))
                        {
                            _builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            _builder.Append(c);
                        }
                        break;
                }
            }
            _builder.Append('"');
        }
    }
}
