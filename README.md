# @waniwani/relay

`@waniwani/relay` records the visits of AI agents to your website and sends them to [Waniwani](https://waniwani.ai). It runs in the middleware of your site, the code that sees each request before your pages do. For each request from an AI agent, it posts one small event to Waniwani after the response has gone out. It never changes the request or the response, and a person who visits your site sends nothing.

## Install

```bash
npm install @waniwani/relay
```

## Setup

The [setup screen](https://app.waniwani.ai/agent-traffic/setup) in Waniwani gives you the code for your platform: Vercel, Cloudflare Workers or AWS CloudFront (Lambda@Edge). For an organization in the EU region, use [eu.app.waniwani.ai](https://eu.app.waniwani.ai/agent-traffic/setup).

## API

### `isAgent(request)`

```ts
function isAgent(
  request: Request | CloudFrontRequest,
  options?: Pick<RelayOptions, "region" | "apiUrl" | "waitUntil" | "rules">,
): boolean;
```

Tells whether the request comes from an AI agent. It reads the headers and the client IP only, never waits on the network and never throws. It returns `true` when any of these hold:

- The `User-Agent` header contains a token from the AI bot list, for example `ChatGPT-User`, `Claude-User`, `GPTBot` or `PerplexityBot`. The list holds the AI bots in the Waniwani bot catalog and the AI bots on [bots.fyi](https://bots.fyi): crawlers that collect training data, AI search bots, fetchers that act for a user and browsing agents. Classic search indexers such as `Googlebot` and `Bingbot`, browsers, `curl` and uptime monitors are not on it.
- The request has a `Signature-Agent` header ([Web Bot Auth](https://datatracker.ietf.org/wg/webbotauth/about/)).
- The client IP sits inside an IP range that an AI vendor publishes for its bots, for example the lists of OpenAI, Anthropic, Perplexity, Mistral, Apple, Common Crawl and DuckDuckGo (DuckAssistBot).
- The request has a `DPoP` header, or its `Authorization` header uses the `DPoP` scheme.

### `recordAgentVisit(request, options?)`

```ts
function recordAgentVisit(
  request: Request | CloudFrontRequest,
  options?: RelayOptions,
): Promise<void>;
```

Posts one event for the request to Waniwani after the response ([`AgentVisitRecord`](#agentvisitrecord)). Needs a secret key setup, otherwise sends nothing. The function never throws, and the promise never rejects.

#### `RelayOptions`

| Option | Default | Purpose |
| --- | --- | --- |
| `region` | `"us"` | The region of your organization: `"us"` sends to `https://app.waniwani.ai`, `"eu"` to `https://eu.app.waniwani.ai` |
| `apiUrl` | The host of `region` | Another Waniwani host, for local development |
| `key` | `process.env.WANIWANI_AGENT_TRAFFIC_KEY` | The key from the setup screen, `wwt_<token>.<org key>` |
| `waitUntil` | Found by itself on Vercel, none on other platforms | Keeps the post alive after the response |
| `rules` | `"remote"` | `"remote"` loads the newest bot list from Waniwani every 12 hours, `"bundled"` uses only the list that ships in the package |
| `omit` | `[]` | Header names, and the fields `matchKey`, `userAgent` and `referer`, to leave out of every event. An event without `matchKey` still counts, but Waniwani then joins it with the chat embed's events on site, user agent and path only, which is less exact. |

#### `AgentVisitRecord`

For each matched request, `recordAgentVisit` posts one JSON record of type `AgentVisitRecord` to Waniwani platform:

| Field | Value |
| --- | --- |
| `occurredAt` | The time of the request, ISO 8601 in UTC |
| `method` | The HTTP method |
| `host` | The hostname of the request URL, without the port |
| `path` | The path with its query string |
| `userAgent`, `referer` | Copies of those two headers |
| `headers` | The request headers from the next table that the request has |
| `matchKey` | `HMAC-SHA256(org key, client IP)` as hex. Waniwani uses it to join this event with other events of the same visit. |
| `sourceEventId` | A random UUID for this request |
| `relayVersion` | The version of this library |
| `platform` | `vercel`, `cloudflare` or `cloudfront`, when the library knows the platform it runs on |

The `headers` field can hold only these request headers:

| Header | What is sent |
| --- | --- |
| `user-agent`, `referer`, `accept`, `accept-language`, `from` | The value as it came |
| `signature-agent`, `signature-input`, `signature` | The value as it came (Web Bot Auth) |
| `dpop` | The value as it came |
| `sec-ch-ua`, `sec-ch-ua-platform`, `sec-ch-ua-mobile` | The value as it came |
| `authorization` | The secret never leaves. Only the scheme word goes out, for example `Bearer`. It goes out only when a credential follows it and the word is one of `Basic`, `Bearer`, `Digest`, `DPoP`, `HOBA`, `Mutual`, `Negotiate`, `NTLM`, `OAuth`, `PrivateToken`, `SCRAM-SHA-1`, `SCRAM-SHA-256`, `vapid` or `AWS4-HMAC-SHA256`. For any other value, such as a raw API key, the event has no `authorization` header. |

#### Platform differences

| Platform | Await the call | Post timeout |
| --- | --- | --- |
| Vercel | No | 2 s, one retry after 500 ms |
| Cloudflare Workers | No | 2 s, one retry after 500 ms |
| AWS CloudFront (Lambda@Edge) | Yes, before the handler returns. Lambda freezes the function when the handler returns, so a post event request that is not awaited is lost. | 1 s, no retry |
| Other | No, when you pass `waitUntil` | 2 s, one retry after 500 ms |

### `serveAgentPage(request, options?)`

```ts
function serveAgentPage(
  request: Request,
  options?: ServeAgentPageOptions,
): Promise<Response | null>;
function serveAgentPage(
  request: CloudFrontRequest,
  options?: ServeAgentPageOptions,
): Promise<CloudFrontResultResponse | null>;
```

`ServeAgentPageOptions` takes `region`, `apiUrl` and `key` from `RelayOptions`, plus `hostname` for CloudFront.

Serves the agent page of a request: a text-first copy of the page that Waniwani renders and stores. It returns that page when all of these hold, and `null` otherwise, so your middleware passes the request on to your site:

- A key is set.
- The method is `GET` or `HEAD`.
- The request has no `x-waniwani-render` header. Waniwani sends that header when it renders your page.
- Agent pages are on in Waniwani for the hostname of the request, and its path is in the list of agent page paths. An entry is an exact path such as `/pricing`, or a folder such as `/products/*`, which covers `/products` and every path under it. `*` covers every path.
- The `User-Agent` belongs to an AI agent that acts for a user, for example `ChatGPT-User` or `Claude-User`. Crawlers that collect training data get your site as usual.
- Waniwani sends the stored page in time. The rules and the deadlines come from your Waniwani settings.

You can block AI agents per site in Waniwani. When the `User-Agent` of a request contains a blocked token, the function answers `403` with the text body `Forbidden`. That check runs before the agent page checks, so it works with agent pages off. The response carries `x-waniwani-blocked: 1`, `cache-control: private, no-store` and `vary: user-agent`.

The page response carries the stored content type, `x-waniwani-agent-page: hit`, `cache-control: private, no-store` and `vary: user-agent, accept`. A `HEAD` request gets the same headers with no body. The settings load on the first call, with a 300 ms limit, and stay in memory for 60 seconds. After that the relay keeps serving the cached settings while it loads new ones in the background. The function never throws, and the promise never rejects.

On Vercel, in `middleware.ts`:

```ts
import { isAgent, recordAgentVisit, serveAgentPage } from "@waniwani/relay";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  if (isAgent(request)) {
    recordAgentVisit(request);
    return (await serveAgentPage(request)) ?? NextResponse.next();
  }
  return NextResponse.next();
}
```

In a Cloudflare Worker, pass the key and fall back to your origin:

```ts
return (await serveAgentPage(request, { key: env.WANIWANI_AGENT_TRAFFIC_KEY })) ?? fetch(request);
```

### `markAgentRequest(request, options?)`

```ts
function markAgentRequest(
  request: CloudFrontRequest,
  options?: Pick<RelayOptions, "region" | "apiUrl" | "waitUntil" | "rules">,
): boolean;
```

On AWS CloudFront the agent page comes from an origin-request Lambda@Edge. A response made there can be 1 MB. At viewer-request the limit is 40 KB. The origin-request event has no viewer `User-Agent` or `Host`, so the viewer-request handler passes the user agent on.

When `isAgent` holds, `markAgentRequest` rewrites `request.uri` to `/__waniwani-agent/<encoded user agent><original path>` and returns `true`. That URI gives each agent user agent its own cache key, apart from the page people get, with no change to your cache policy, and it carries the user agent to the origin-request handler. A `/__waniwani-agent/` prefix the client sent is stripped first. The function never throws. Call `recordAgentVisit` before it, so the event holds the original path.

Viewer-request handler:

```ts
const request = event.Records[0].cf.request;
if (isAgent(request)) await recordAgentVisit(request, { key });
markAgentRequest(request);
return request;
```

Origin-request handler:

```ts
const request = event.Records[0].cf.request;
return (await serveAgentPage(request, { key, hostname })) ?? request;
```

Lambda@Edge has no environment variables, so pass `key`. `hostname` is the hostname of your site, and the setup screen puts it in the code for you. Without it the relay reads the `host` header, which at origin-request names your origin. For a `CloudFrontRequest` the user agent comes from the URI that `markAgentRequest` rewrote. The function restores `request.uri` to the original path before anything else, so `?? request` reaches your origin with the real path, and it returns `null` when the URI has no `/__waniwani-agent/` prefix. The page body goes out as UTF-8 text.

## Dependencies

The package has no runtime dependencies. The IP range check uses `BlockList` from `node:net`.

## Development

```bash
bun install
bun run build   # typecheck, lint and dist/index.js
bun run test    # unit tests (run the build first, one test imports dist)
bun run rules   # writes the two src/logic/*.generated.json files from the app rules file
```

`bun run rules` reads `https://app.waniwani.ai/api/v2/agent-traffic/rules`, or the URL in `RULES_URL`, and writes `src/logic/agents.generated.json` and `src/logic/ip-ranges.generated.json`, the fallback list that ships in the package. Never edit them by hand. `npm version` runs it before every release and commits the two files with the new version. When the rules route does not answer, the release stops before the version changes.

## License

[Apache 2.0](LICENSE)
