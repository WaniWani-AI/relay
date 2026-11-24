# Waniwani relay for .NET

The relay records AI agent visits to your website and sends them to Waniwani. It can also give AI agents the Waniwani agent page of a URL. Requests from persons go to your site as usual. The relay adds less than 50 µs to them and never waits on the network for them.

This is a port of the TypeScript relay `@waniwani/relay`. A package version is the TypeScript version whose fixtures it passes. The packages are open source under Apache 2.0, so your security team can read all the code.

| Package | Use it for |
| --- | --- |
| `Waniwani.Relay.AspNet` | Classic ASP.NET (System.Web) on IIS, .NET Framework 4.6.2 or later |
| `Waniwani.Relay.AspNetCore` | ASP.NET Core 8 or later |
| `Waniwani.Relay` | The core. The other two packages use it. It has no dependencies. |

## Classic ASP.NET on IIS

1. Add the package:

   ```
   Install-Package Waniwani.Relay.AspNet
   ```

2. Make sure that `web.config` registers the module. The package adds it for `packages.config` projects. Do not add `preCondition="managedHandler"`, so that the module also runs for static files such as `/llms.txt`.

   ```xml
   <system.webServer>
     <modules>
       <add name="WaniwaniRelay" type="Waniwani.Relay.AspNet.WaniwaniRelayModule, Waniwani.Relay.AspNet" />
     </modules>
   </system.webServer>
   ```

3. Set the key from the Waniwani setup screen, and your region:

   ```xml
   <appSettings>
     <add key="Waniwani:AgentTrafficKey" value="wwt_..." />
     <add key="Waniwani:Region" value="eu" />
   </appSettings>
   ```

## ASP.NET Core

```csharp
builder.Services.AddWaniwaniRelay();
var app = builder.Build();
app.UseWaniwaniRelay();
```

Put `UseWaniwaniRelay()` before `UseStaticFiles()` and routing. The settings are in the `Waniwani` section of `appsettings.json`.

## Settings

| Key | Default | Use |
| --- | --- | --- |
| `Waniwani:AgentTrafficKey` | The `WANIWANI_AGENT_TRAFFIC_KEY` environment variable | The `wwt_` key from the setup screen. |
| `Waniwani:Region` | `us` | `us` or `eu`. |
| `Waniwani:ClientIpHeader` | None | The header in which your CDN or load balancer puts the visitor IP, for example `X-Forwarded-For`. |
| `Waniwani:TrustedProxies` | None | The addresses and CIDR ranges of your CDN and load balancers, separated by commas. The relay reads `ClientIpHeader` only when the request comes from one of them. |
| `Waniwani:Rules` | `remote` | `remote` loads the newest AI bot list every 12 hours. `bundled` keeps the list in this package. |
| `Waniwani:Omit` | None | Headers, or the fields `userAgent`, `referer` and `matchKey`, to leave out of every event. |
| `Waniwani:Enabled` | `true` | Set it to `false` to stop the relay without a deploy. |

## Behind a CDN or a load balancer

Without `ClientIpHeader`, the relay sees the address of your CDN or load balancer for all visitors. Detection by user agent still works, but detection by IP range does not. Set `ClientIpHeader` and `TrustedProxies` together. The relay reads the header from the right and uses the first address that is not a trusted proxy. Thus a visitor cannot send a false `X-Forwarded-For`.

## Caches

The relay runs at `BeginRequest`, before the ASP.NET output cache. It turns off the kernel cache (http.sys) for the paths that have agent pages. A CDN in front of IIS can still answer an agent from its cache, and then the relay does not see the visit. Make sure that your CDN does not keep HTML pages for agents, or that it sends requests with `Accept: text/markdown` to IIS.

## Outbound calls

The relay makes HTTPS calls to these hosts:

| Region | Hosts |
| --- | --- |
| `us` | `app.waniwani.ai` and `pages.waniwani.tools` |
| `eu` | `eu.app.waniwani.ai` and `eu-pages.waniwani.tools` |

The first host gives the site rules and gets the events. The second host gives the agent pages. When the relay cannot get to them, your site works as usual.

The relay sends one event for each agent visit, in batches, from a background queue. The queue holds 1,000 events. When it is full, new events are dropped. When the app pool recycles, the relay waits up to 5 seconds to send the queue.
