using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Xunit;
using Xunit.Abstractions;

namespace Waniwani.Relay.Tests
{
    [CollectionDefinition("performance", DisableParallelization = true)]
    public sealed class PerformanceCollection
    {
    }

    [Collection("performance")]
    public sealed class PerformanceTests
    {
        private readonly ITestOutputHelper _output;

        public PerformanceTests(ITestOutputHelper output)
        {
            _output = output;
        }

        [Fact]
        public async Task APersonCostsLessThan50MicrosecondsAtP99()
        {
            var relay = new Relay(new RelayOptions { AgentTrafficKey = "wwt_perf.b3JnLWtleQ", BaseUrl = "http://127.0.0.1:9", Rules = "bundled" }, "aspnet", new HttpClient(), new SystemClock(), "0.0.0");
            var headers = new Dictionary<string, string>
            {
                ["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                ["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["accept-language"] = "fr-FR,fr;q=0.9",
                ["referer"] = "https://www.google.com/",
            };
            var request = new RelayRequest("GET", "www.example.com", "/assurance-auto.aspx", string.Empty, headers, "203.0.113.10");
            const int batch = 50;
            var samples = new List<double>();
            for (var round = 0; round < 4_000; round++)
            {
                var watch = Stopwatch.StartNew();
                for (var i = 0; i < batch; i++)
                {
                    if (relay.IsAgent(request))
                    {
                        relay.RecordAgentVisit(request);
                    }
                    relay.MayServe(request);
                    if (await relay.ServeAgentPageAsync(request) != null)
                    {
                        throw new InvalidOperationException("a person got an answer");
                    }
                }
                watch.Stop();
                if (round >= 500)
                {
                    samples.Add(watch.Elapsed.TotalMilliseconds * 1000 / batch);
                }
            }
            samples.Sort();
            var p50 = samples[samples.Count / 2];
            var p99 = samples[(int)(samples.Count * 0.99)];
            _output.WriteLine($"person path p50 {p50:F2} µs, p99 {p99:F2} µs");
            Assert.True(p99 < 50, $"p99 is {p99:F2} µs");
        }
    }
}
