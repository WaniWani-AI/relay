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
| `uses` | The relay functions this process called so far: `recordAgentVisit`, `serveAgentPage` and `handleViewerRequest`. Waniwani reads it to tell whether the code has the calls that agent pages and blocking need |

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

`ServeAgentPageOptions` takes `region`, `apiUrl` and `key` from `RelayOptions`.

Serves the agent page of a request: a text-first copy of the page that Waniwani renders and stores. It returns that page when all of these hold, and `null` otherwise, so your middleware passes the request on to your site:

- A key is set.
- The method is `GET` or `HEAD`.
- The request has no `x-waniwani-render` header. Waniwani sends that header when it renders your page.
- Agent pages are on in Waniwani for the hostname of the request, and its path is in the list of agent page paths. An entry is an exact path such as `/pricing`, or a folder such as `/products/*`, which covers `/products` and every path under it. `*` covers every path.
- The `User-Agent` belongs to an AI agent that acts for a user, for example `ChatGPT-User` or `Claude-User`. Crawlers that collect training data get your site as usual.
- Waniwani sends the stored page in time. The rules and the deadlines come from your Waniwani settings.

You can block AI agents per site in Waniwani. When the `User-Agent` of a `GET` or `HEAD` request contains a blocked token, the function answers `403` with the text body `Forbidden`. That check runs before the agent page checks and before the `x-waniwani-render` check, so it works with agent pages off. The response carries `x-waniwani-blocked: 1`, `cache-control: private, no-store` and `vary: user-agent`.

The agent gets the page as Markdown when its `Accept` header lists `text/markdown` with a `q` above 0. Every other agent gets the page as HTML, including an agent that sends `*/*` or no `Accept` header.

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

### `handleViewerRequest(request, options?)` and CloudFront

```ts
function handleViewerRequest(
  request: CloudFrontRequest,
  options?: ServeAgentPageOptions,
): Promise<CloudFrontResultResponse | null>;
```

CloudFront needs two Lambda@Edge functions, one on each of two events. On Vercel and Cloudflare one function sends the agent page. On CloudFront that is not possible, because of a Lambda@Edge limit on the body of a response that the function makes itself:

| Event | Body limit |
| --- | --- |
| Viewer request | 40 KB |
| Origin request | 1 MB |

Most agent pages are larger than 40 KB, so the page must come from origin request. But origin request runs only on a cache miss. When people already opened `/pricing`, CloudFront has that page in its cache, and an agent request for `/pricing` gets the cached copy without a call to origin request. The viewer-request function therefore changes the path of an agent request, so that the request has a different cache key and is always a cache miss.

The mark goes in the path because the path is the only part of the request that is in the cache key with every cache policy. A header or the query string is in the cache key only when the cache policy of your behavior includes it, and the managed `CachingOptimized` policy includes neither. The mark also carries the hostname of the site, because at origin request CloudFront usually replaces the `Host` header with the domain of your origin.

The two events do these jobs:

- **Viewer request** runs on every request, before the CloudFront cache. `handleViewerRequest` decides what to do with the request:
  - When the site blocks this `User-Agent`, it answers `403`. CloudFront does not cache a response from this event, so a change to your block list applies to the next request.
  - When an AI agent that acts for a user asks for a path that has an agent page, it marks the request. To mark it, it adds `/__waniwani-agent/<format>/<host>` in front of the path in `request.uri`. The format is `markdown` or `html`, from the agent's `Accept` header. On CloudFront, `request.uri` is the path only, with no host and no query string. For `https://example.com/pricing?a=1` from an agent that asks for HTML, `request.uri` changes from `/pricing` to `/__waniwani-agent/html/example.com/pricing`, and the query string stays as it is.
  - In all other cases it returns `null`, and the request continues with no change.
- **Origin request** runs only on a cache miss, which is when CloudFront has no stored response for the request. The agent page has `cache-control: private, no-store`, so CloudFront never stores it, and a marked request is always a cache miss. `serveAgentPage` sends the agent page for a marked request. It removes the mark first. So when it cannot send the page, `?? request` sends the original path to your origin.

A client cannot mark its own request. The viewer handler removes a `/__waniwani-agent/` prefix that arrives from the client. Neither function throws.

Viewer-request handler:

```ts
const request = event.Records[0].cf.request;
if (isAgent(request)) await recordAgentVisit(request, { key });
return (await handleViewerRequest(request, { key })) ?? request;
```

Origin-request handler:

```ts
const request = event.Records[0].cf.request;
return (await serveAgentPage(request, { key })) ?? request;
```

Only requests that will get an agent page are marked, so crawlers and people share the normal cache entry, and each listed path gets one extra entry. Lambda@Edge has no environment variables, so pass `key`. People never wait on the site rules: the viewer handler loads them only for an AI agent. A page too large for the 1 MB limit of Lambda@Edge falls through to your origin, and the body goes out as UTF-8 text.

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
