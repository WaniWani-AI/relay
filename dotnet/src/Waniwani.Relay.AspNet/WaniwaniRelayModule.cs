using System;
using System.Collections.Generic;
using System.Configuration;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using System.Web;
using System.Web.Hosting;

namespace Waniwani.Relay.AspNet
{
    /// <summary>
    /// Records AI agent visits and serves Waniwani agent pages in the IIS integrated pipeline.
    /// Register it in <c>system.webServer/modules</c> without <c>preCondition="managedHandler"</c>, so that it also runs for static files.
    /// </summary>
    public sealed class WaniwaniRelayModule : IHttpModule
    {
        public const string Platform = "aspnet";

        private static readonly object Gate = new object();
        private static Relay? _relay;

        private static readonly string[] ReadHeaders = CappedHeaders().Concat(new[] { "x-waniwani-render", "content-length" }).ToArray();

        private static IEnumerable<string> CappedHeaders()
        {
            return new[]
            {
                "user-agent", "referer", "accept", "accept-language", "from", "signature-agent", "signature-input", "signature", "dpop", "sec-ch-ua",
                "sec-ch-ua-platform", "sec-ch-ua-mobile", "authorization",
            };
        }

        public void Init(HttpApplication application)
        {
            var relay = Shared();
            if (relay == null || !relay.Enabled)
            {
                return;
            }
            var helper = new EventHandlerTaskAsyncHelper(context => OnBeginRequestAsync(relay, (HttpApplication)context));
            application.AddOnBeginRequestAsync(helper.BeginEventHandler, helper.EndEventHandler);
        }

        public void Dispose()
        {
        }

        private static Relay? Shared()
        {
            lock (Gate)
            {
                if (_relay != null)
                {
                    return _relay;
                }
                try
                {
                    var options = ReadOptions();
                    EnableTls12();
                    _relay = new Relay(options, Platform);
                    if (options.Enabled)
                    {
                        HostingEnvironment.RegisterObject(new Shutdown(_relay));
                    }
                }
                catch (Exception error)
                {
                    System.Diagnostics.Trace.TraceWarning("[Waniwani.Relay] The relay did not start: " + error.Message);
                    _relay = null;
                }
                return _relay;
            }
        }

        private static RelayOptions ReadOptions()
        {
            var settings = ConfigurationManager.AppSettings;
            string? Read(string name)
            {
                var value = settings["Waniwani:" + name];
                return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            }
            IList<string> List(string name)
            {
                return (Read(name) ?? string.Empty).Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            }
            return new RelayOptions
            {
                AgentTrafficKey = Read("AgentTrafficKey"),
                Region = Read("Region") ?? "us",
                BaseUrl = Read("BaseUrl"),
                ClientIpHeader = Read("ClientIpHeader"),
                TrustedProxies = List("TrustedProxies"),
                Rules = Read("Rules") ?? "remote",
                Omit = List("Omit"),
                Enabled = !string.Equals(Read("Enabled"), "false", StringComparison.OrdinalIgnoreCase),
            };
        }

        private static void EnableTls12()
        {
            try
            {
                var current = ServicePointManager.SecurityProtocol;
                if (current != 0 && (current & SecurityProtocolType.Tls12) == 0)
                {
                    ServicePointManager.SecurityProtocol = current | SecurityProtocolType.Tls12;
                }
            }
            catch
            {
            }
        }

        private static async Task OnBeginRequestAsync(Relay relay, HttpApplication application)
        {
            try
            {
                var context = application.Context;
                var request = context.Request;
                var headers = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var name in ReadHeaders)
                {
                    var values = request.Headers.GetValues(name);
                    if (values != null && values.Length > 0)
                    {
                        headers[name] = string.Join(", ", values);
                    }
                }
                var clientIpHeader = relay.ClientIpHeader;
                if (clientIpHeader != null)
                {
                    var values = request.Headers.GetValues(clientIpHeader);
                    if (values != null && values.Length > 0)
                    {
                        headers[clientIpHeader] = string.Join(", ", values);
                    }
                }
                var rawUrl = request.RawUrl ?? "/";
                var question = rawUrl.IndexOf('?');
                var path = question >= 0 ? rawUrl.Substring(0, question) : rawUrl;
                var query = question >= 0 ? rawUrl.Substring(question + 1) : string.Empty;
                var relayRequest = new RelayRequest(request.HttpMethod, request.Headers["Host"], path, query, headers, request.UserHostAddress ?? string.Empty)
                {
                    ReadBody = (maxBytes, deadline) => ReadBodyAsync(request, maxBytes, deadline),
                };
                if (relay.IsAgent(relayRequest))
                {
                    relay.RecordAgentVisit(relayRequest);
                }
                var method = request.HttpMethod;
                if ((method == "GET" || method == "HEAD") && relay.MayServe(relayRequest))
                {
                    context.Response.DisableKernelCache();
                }
                var answer = await relay.ServeAgentPageAsync(relayRequest);
                if (answer == null)
                {
                    return;
                }
                Write(context, answer);
                application.CompleteRequest();
            }
            catch (Exception error)
            {
                System.Diagnostics.Trace.TraceWarning("[Waniwani.Relay] A request failed in the relay and went to the site: " + error.GetType().Name);
            }
        }

        private static void Write(HttpContext context, RelayAnswer answer)
        {
            var response = context.Response;
            response.Clear();
            response.StatusCode = answer.Status;
            response.TrySkipIisCustomErrors = true;
            response.Cache.SetCacheability(HttpCacheability.Private);
            response.Cache.SetNoStore();
            response.Cache.SetNoServerCaching();
            foreach (var header in answer.Headers)
            {
                switch (header.Key)
                {
                    case "content-type":
                        response.ContentType = header.Value;
                        break;
                    case "cache-control":
                        break;
                    default:
                        response.AppendHeader(header.Key, header.Value);
                        break;
                }
            }
            if (answer.Body != null && answer.Body.Length > 0)
            {
                response.OutputStream.Write(answer.Body, 0, answer.Body.Length);
            }
            if (context.Request.HttpMethod == "HEAD")
            {
                response.SuppressContent = true;
            }
        }

        /// <summary>Reads the body through <see cref="HttpRequest.GetBufferedInputStream"/> to the end, so the site can still read it.</summary>
        private static async Task<byte[]?> ReadBodyAsync(HttpRequest request, int maxBytes, TimeSpan deadline)
        {
            var started = DateTime.UtcNow;
            using (var buffer = new MemoryStream())
            {
                var stream = request.GetBufferedInputStream();
                var chunk = new byte[16 * 1024];
                var tooLarge = false;
                while (true)
                {
                    var read = await stream.ReadAsync(chunk, 0, chunk.Length);
                    if (read == 0)
                    {
                        break;
                    }
                    if (buffer.Length + read > maxBytes)
                    {
                        tooLarge = true;
                        continue;
                    }
                    buffer.Write(chunk, 0, read);
                }
                if (tooLarge || DateTime.UtcNow - started > deadline)
                {
                    return null;
                }
                return buffer.ToArray();
            }
        }

        private sealed class Shutdown : IRegisteredObject
        {
            private readonly Relay _relay;

            public Shutdown(Relay relay)
            {
                _relay = relay;
            }

            public void Stop(bool immediate)
            {
                if (immediate)
                {
                    HostingEnvironment.UnregisterObject(this);
                    return;
                }
                Task.Run(async () =>
                {
                    await _relay.ShutdownAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                    HostingEnvironment.UnregisterObject(this);
                });
            }
        }
    }
}
