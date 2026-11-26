using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Waniwani.Relay
{
    internal sealed class PendingRecord
    {
        public PendingRecord(string ingestUrl, Func<string> toJson)
        {
            IngestUrl = ingestUrl;
            ToJson = toJson;
        }

        public string IngestUrl { get; }
        public Func<string> ToJson { get; }
    }

    /// <summary>Sends records in the background. The request thread only writes to a bounded queue, and a full queue drops the record.</summary>
    internal sealed class IngestQueue
    {
        public const int Capacity = 1000;
        public const int MaxBatch = 100;

        private readonly HttpClient _http;
        private readonly ConcurrentQueue<PendingRecord> _queue = new ConcurrentQueue<PendingRecord>();
        private readonly SemaphoreSlim _signal = new SemaphoreSlim(0);
        private readonly CancellationTokenSource _stopping = new CancellationTokenSource();
        private readonly Action<string> _warn;
        private readonly Task _sender;
        private int _count;
        private int _completed;

        public IngestQueue(HttpClient http, Action<string> warn)
        {
            _http = http;
            _warn = warn;
            _sender = Task.Run(SendLoopAsync);
        }

        public int Dropped;

        public void Enqueue(PendingRecord record)
        {
            if (Volatile.Read(ref _completed) == 1 || Interlocked.Increment(ref _count) > Capacity)
            {
                if (Volatile.Read(ref _completed) == 0)
                {
                    Interlocked.Decrement(ref _count);
                }
                Interlocked.Increment(ref Dropped);
                return;
            }
            _queue.Enqueue(record);
            _signal.Release();
        }

        /// <summary>Stops taking records and waits up to <paramref name="timeout"/> for the queue to empty.</summary>
        public async Task DrainAsync(TimeSpan timeout)
        {
            if (Interlocked.Exchange(ref _completed, 1) == 0)
            {
                _signal.Release();
            }
            var finished = await Task.WhenAny(_sender, Task.Delay(timeout)).ConfigureAwait(false);
            if (finished != _sender)
            {
                _stopping.Cancel();
            }
        }

        private async Task SendLoopAsync()
        {
            var batch = new List<PendingRecord>(MaxBatch);
            while (true)
            {
                await _signal.WaitAsync().ConfigureAwait(false);
                batch.Clear();
                while (batch.Count < MaxBatch && _queue.TryDequeue(out var record))
                {
                    batch.Add(record);
                    Interlocked.Decrement(ref _count);
                }
                if (batch.Count == 0)
                {
                    if (Volatile.Read(ref _completed) == 1)
                    {
                        return;
                    }
                    continue;
                }
                foreach (var group in GroupByUrl(batch))
                {
                    if (_stopping.IsCancellationRequested)
                    {
                        return;
                    }
                    try
                    {
                        await PostAsync(group.Key, Body(group.Value)).ConfigureAwait(false);
                    }
                    catch
                    {
                    }
                }
                if (Volatile.Read(ref _completed) == 1 && _queue.IsEmpty)
                {
                    return;
                }
            }
        }

        private static Dictionary<string, List<PendingRecord>> GroupByUrl(List<PendingRecord> batch)
        {
            var groups = new Dictionary<string, List<PendingRecord>>(StringComparer.Ordinal);
            foreach (var record in batch)
            {
                if (!groups.TryGetValue(record.IngestUrl, out var list))
                {
                    list = new List<PendingRecord>();
                    groups[record.IngestUrl] = list;
                }
                list.Add(record);
            }
            return groups;
        }

        private static string Body(List<PendingRecord> records)
        {
            var builder = new StringBuilder("{\"requests\":[");
            for (var i = 0; i < records.Count; i++)
            {
                if (i > 0)
                {
                    builder.Append(',');
                }
                builder.Append(records[i].ToJson());
            }
            return builder.Append("]}").ToString();
        }

        private async Task PostAsync(string url, string body)
        {
            var outcome = await PostOnceAsync(url, body).ConfigureAwait(false);
            if (outcome.Retryable && !outcome.Success)
            {
                await Task.Delay(Settings.RetryDelayMs, _stopping.Token).ConfigureAwait(false);
                outcome = await PostOnceAsync(url, body).ConfigureAwait(false);
            }
            if (!outcome.Success)
            {
                _warn("Could not record an agent visit (" + outcome.Description + "). The event was dropped.");
            }
        }

        private readonly struct Outcome
        {
            public Outcome(bool success, bool retryable, string description)
            {
                Success = success;
                Retryable = retryable;
                Description = description;
            }

            public bool Success { get; }
            public bool Retryable { get; }
            public string Description { get; }
        }

        private async Task<Outcome> PostOnceAsync(string url, string body)
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stopping.Token))
            {
                timeout.CancelAfter(Settings.RequestTimeoutMs);
                try
                {
                    using (var content = new StringContent(body, Encoding.UTF8, "application/json"))
                    using (var response = await _http.PostAsync(url, content, timeout.Token).ConfigureAwait(false))
                    {
                        var status = (int)response.StatusCode;
                        return new Outcome(status >= 200 && status < 300, status == 429 || status >= 500, "status " + status);
                    }
                }
                catch (OperationCanceledException)
                {
                    return new Outcome(false, true, "timeout");
                }
                catch
                {
                    return new Outcome(false, true, "network");
                }
            }
        }
    }

    internal static class RecordJson
    {
        public static string Write(
            string occurredAt,
            string method,
            string host,
            string path,
            IReadOnlyDictionary<string, string> headers,
            string sourceEventId,
            string relayVersion,
            IEnumerable<string> uses,
            string? userAgent,
            string? referer,
            string? platform,
            string? matchKey,
            string? visitor)
        {
            var writer = new JsonWriter();
            writer.StartObject()
                .String("occurredAt", occurredAt)
                .String("method", method)
                .String("host", host)
                .String("path", path)
                .StartObject("headers");
            foreach (var pair in headers)
            {
                writer.String(pair.Key, pair.Value);
            }
            writer.EndObject().String("sourceEventId", sourceEventId).String("relayVersion", relayVersion).StartArray("uses");
            foreach (var use in uses)
            {
                writer.String(null, use);
            }
            writer.EndArray();
            if (userAgent != null)
            {
                writer.String("userAgent", userAgent);
            }
            if (referer != null)
            {
                writer.String("referer", referer);
            }
            if (platform != null)
            {
                writer.String("platform", platform);
            }
            if (matchKey != null)
            {
                writer.String("matchKey", matchKey);
            }
            if (visitor != null)
            {
                writer.String("visitor", visitor);
            }
            return writer.EndObject().ToString();
        }
    }
}
