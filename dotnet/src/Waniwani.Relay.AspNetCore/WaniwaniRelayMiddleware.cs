using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Waniwani.Relay.AspNetCore
{
    public static class WaniwaniRelayExtensions
    {
        public const string Platform = "aspnet";

        /// <summary>Adds the relay. Reads the <c>Waniwani</c> section of the configuration, then applies <paramref name="configure"/>.</summary>
        public static IServiceCollection AddWaniwaniRelay(this IServiceCollection services, Action<RelayOptions>? configure = null)
        {
            services.AddSingleton(provider =>
            {
                var options = new RelayOptions();
                var section = provider.GetService<IConfiguration>()?.GetSection("Waniwani");
                if (section != null)
                {
                    options.AgentTrafficKey = section["AgentTrafficKey"] ?? options.AgentTrafficKey;
                    options.Region = section["Region"] ?? options.Region;
                    options.BaseUrl = section["BaseUrl"] ?? options.BaseUrl;
                    options.ClientIpHeader = section["ClientIpHeader"] ?? options.ClientIpHeader;
                    options.Rules = section["Rules"] ?? options.Rules;
                    options.Enabled = !string.Equals(section["Enabled"], "false", StringComparison.OrdinalIgnoreCase);
                    options.TrustedProxies = List(section, "TrustedProxies");
                    options.Omit = List(section, "Omit");
                }
                configure?.Invoke(options);
                return new Relay(options, Platform);
            });
            services.AddHostedService<RelayShutdown>();
            return services;
        }

        private static IList<string> List(IConfigurationSection section, string name)
        {
            var child = section.GetSection(name);
            var items = child.GetChildren().Select(item => item.Value).Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!).ToList();
            if (items.Count > 0)
            {
                return items;
            }
            return (child.Value ?? string.Empty).Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries).ToList();
        }

        /// <summary>Adds the relay middleware. Put it before static files and routing, so that it sees every request.</summary>
        public static IApplicationBuilder UseWaniwaniRelay(this IApplicationBuilder app)
        {
            return app.UseMiddleware<WaniwaniRelayMiddleware>();
        }
    }

    internal sealed class RelayShutdown : IHostedService
    {
        private readonly Relay _relay;

        public RelayShutdown(Relay relay)
        {
            _relay = relay;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            return _relay.ShutdownAsync(TimeSpan.FromSeconds(5));
        }
    }

    public sealed class WaniwaniRelayMiddleware
    {
        private static readonly string[] ReadHeaders =
        {
            "user-agent", "referer", "accept", "accept-language", "from", "signature-agent", "signature-input", "signature", "dpop", "sec-ch-ua",
            "sec-ch-ua-platform", "sec-ch-ua-mobile", "authorization", "x-waniwani-render", "content-length",
        };

        private readonly RequestDelegate _next;
        private readonly Relay _relay;

        public WaniwaniRelayMiddleware(RequestDelegate next, Relay relay)
        {
            _next = next;
            _relay = relay;
        }

        public async Task InvokeAsync(HttpContext context)
        {
            RelayAnswer? answer = null;
            if (_relay.Enabled)
            {
                try
                {
                    var request = context.Request;
                    var headers = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (var name in ReadHeaders.Concat(_relay.ClientIpHeader != null ? new[] { _relay.ClientIpHeader } : Array.Empty<string>()))
                    {
                        if (request.Headers.TryGetValue(name, out var values) && values.Count > 0)
                        {
                            headers[name] = string.Join(", ", values.ToArray());
                        }
                    }
                    var relayRequest = new RelayRequest(
                        request.Method,
                        request.Host.HasValue ? request.Host.Value : null,
                        request.PathBase.Add(request.Path).ToUriComponent(),
                        request.QueryString.HasValue ? request.QueryString.Value!.Substring(1) : string.Empty,
                        headers,
                        context.Connection.RemoteIpAddress?.ToString() ?? string.Empty)
                    {
                        ReadBody = (maxBytes, deadline) => ReadBodyAsync(request, maxBytes, deadline),
                    };
                    if (_relay.IsAgent(relayRequest))
                    {
                        _relay.RecordAgentVisit(relayRequest);
                    }
                    answer = await _relay.ServeAgentPageAsync(relayRequest);
                }
                catch
                {
                    answer = null;
                }
            }
            if (answer == null)
            {
                await _next(context);
                return;
            }
            var response = context.Response;
            response.StatusCode = answer.Status;
            foreach (var header in answer.Headers)
            {
                response.Headers.Append(header.Key, header.Value);
            }
            if (answer.Body != null && !HttpMethods.IsHead(context.Request.Method))
            {
                await response.Body.WriteAsync(answer.Body, 0, answer.Body.Length);
            }
        }

        private static async Task<byte[]?> ReadBodyAsync(HttpRequest request, int maxBytes, TimeSpan deadline)
        {
            request.EnableBuffering();
            using var cancel = new CancellationTokenSource(deadline);
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            try
            {
                while (true)
                {
                    var read = await request.Body.ReadAsync(chunk.AsMemory(0, chunk.Length), cancel.Token);
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
            catch (OperationCanceledException)
            {
                return null;
            }
            finally
            {
                request.Body.Position = 0;
            }
        }
    }
}
