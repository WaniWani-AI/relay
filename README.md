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
function isAgent(request: Request | CloudFrontRequest): boolean;
```

Tells whether the request comes from an AI agent. It reads the headers and the client IP only. It makes no network call, keeps no state between requests and never throws. It returns `true` when any of these hold:

- The `User-Agent` header contains a token from the AI bot list, for example `ChatGPT-User`, `Claude-User`, `GPTBot` or `PerplexityBot`. The list comes from the AI bots in the Waniwani bot catalog: crawlers that collect training data, AI search bots and fetchers that act for a user. Classic search indexers such as `Googlebot` and `Bingbot`, browsers, `curl` and uptime monitors are not on it.
- The request has a `Signature-Agent` header ([Web Bot Auth](https://datatracker.ietf.org/wg/webbotauth/about/)).
- The client IP sits inside an IP range that an AI vendor publishes for its bots. Today the ranges come from OpenAI, Perplexity, Mistral, Common Crawl and DuckDuckGo (DuckAssistBot).
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

## Dependencies

The package has no runtime dependencies. The IP range check uses `BlockList` from `node:net`.

## Development

```bash
bun install
bun run build   # typecheck, lint and dist/index.js
bun run test    # unit tests (run the build first, one test imports dist)
bun run rules   # refreshes src/logic/ip-ranges.generated.json from the vendors' published lists
```

`src/logic/agents.json` is copied by hand from the Waniwani bot catalog (`src/lib/agent-traffic/bot-catalog.ts` in the Waniwani app): every entry of kind `training`, `search` or `fetcher`, using its `token` when it has one and its lowercased name otherwise.

## License

[Apache 2.0](LICENSE)
