# @waniwani/relay

`@waniwani/relay` records the visits of AI agents to your website and sends them to [WaniWani](https://waniwani.ai). It runs in the middleware of your site, the code that sees each request before your pages do. For each request from an AI agent, it posts one small event to WaniWani after the response has gone out. It never changes the request or the response, and a person who visits your site sends nothing.

The code is Apache 2.0 licensed and short, so your security team can read all of it before you deploy.

## Install

```bash
npm install @waniwani/relay
```

Copy the key from the WaniWani setup screen into the environment variable `WANIWANI_AGENT_TRAFFIC_KEY` of your production deployment. When the variable is not set, the library sends nothing, so preview deployments and local runs stay silent.

## Vercel

### Next.js

Next.js 16 calls its middleware file `proxy.ts` (it was `middleware.ts` before). Add the two calls to that file:

```ts
// proxy.ts
import { isAgent, recordAgentVisit } from "@waniwani/relay";

export default function proxy(request: Request) {
  if (isAgent(request)) {
    recordAgentVisit(request);
  }
}

export const config = {
  matcher: ["/((?!api/|_next/|.*\\.[a-z0-9]{1,5}$).*)", "/robots.txt", "/llms.txt"],
};
```

If you already have a proxy, put the `if` block at the top of your proxy function and leave the rest as it is. The matcher keeps `/api/`, `/_next/` and every path with a file extension out of the middleware, so scripts, images, fonts and API calls never run it. It lists `/robots.txt` and `/llms.txt` by name, because AI agents read them.

### Other frameworks

Point Vercel at the middleware file with the `proxy` property in `vercel.json` (the same key works in `vercel.ts`):

```json
{
  "proxy": {
    "entrypoint": "proxy.ts",
    "matcher": ["/((?!api/|.*\\.[a-z0-9]{1,5}$).*)", "/robots.txt", "/llms.txt"]
  }
}
```

```ts
// proxy.ts
import { isAgent, recordAgentVisit } from "@waniwani/relay";

export default function proxy(request: Request) {
  if (isAgent(request)) {
    recordAgentVisit(request);
  }
}
```

If your organization is in the EU region, pass the region. Its events then go only to the EU host:

```ts
recordAgentVisit(request, { region: "eu" });
```

The setup screen shows the code for your organization.

## How a request is matched

`isAgent(request)` reads a few request headers and the client IP. It makes no network call and keeps no state between requests. It returns `true` when any of these hold:

- The `User-Agent` header contains a token from the AI bot list, for example `ChatGPT-User`, `Claude-User`, `GPTBot` or `PerplexityBot`. The list comes from the AI bots in the WaniWani bot catalog: crawlers that collect training data, AI search bots and fetchers that act for a user. Classic search indexers such as `Googlebot` and `Bingbot`, browsers, `curl` and uptime monitors are not on it.
- The request has a `Signature-Agent` header ([Web Bot Auth](https://datatracker.ietf.org/wg/webbotauth/about/)).
- The client IP sits inside an IP range that an AI vendor publishes for its bots. Today the ranges come from OpenAI, Perplexity, Mistral, Common Crawl and DuckDuckGo (DuckAssistBot).
- The request has a `DPoP` header, or its `Authorization` header uses the `DPoP` scheme.

## What is sent

For each matched request, `recordAgentVisit` posts one JSON record to `<host>/api/v2/agent-traffic/ingest/middleware/<token>`:

| Field | Value |
| --- | --- |
| `occurredAt` | The time of the request, ISO 8601 in UTC |
| `method` | The HTTP method |
| `host` | The hostname of the request URL, without the port |
| `path` | The path with its query string |
| `userAgent`, `referer` | Copies of those two headers |
| `headers` | The allowed headers that the request has (see below) |
| `matchKey` | `HMAC-SHA256(org key, client IP)` as hex. WaniWani uses it to join this event with other events of the same visit. |
| `sourceEventId` | A random UUID for this request |
| `relayVersion` | The version of this library |
| `platform` | `vercel` or `cloudflare`, when the library knows the platform it runs on |

Only these headers can ever go into an event: `user-agent`, `referer`, `accept`, `accept-language`, `from`, `signature-agent`, `signature-input`, `signature`, `dpop`, `sec-ch-ua`, `sec-ch-ua-platform`, `sec-ch-ua-mobile` and `authorization`. For `authorization` the library sends the scheme word alone, in its standard spelling, and only when a credential follows it and the word is one of `Basic`, `Bearer`, `Digest`, `DPoP`, `HOBA`, `Mutual`, `Negotiate`, `NTLM`, `OAuth`, `PrivateToken`, `SCRAM-SHA-1`, `SCRAM-SHA-256`, `vapid` or `AWS4-HMAC-SHA256`. Any other value sends no `authorization` header at all, so a raw API key in that header never leaves your deployment.

These never leave your deployment:

- The `cookie` header. The library never reads it.
- The credential in the `Authorization` header.
- The raw client IP. The library turns it into the match key with your org key and never logs it. The org key is the part of `WANIWANI_AGENT_TRAFFIC_KEY` after the dot, so two organizations get unrelated match keys for the same IP.
- The request body, other headers and your environment variables.

### Sending less

`omit` takes header names, plus the field names `matchKey`, `userAgent` and `referer`. Whatever it names is left out of every event:

```ts
recordAgentVisit(request, {
  omit: ["accept-language", "matchKey"],
});
```

An event without a match key still counts. WaniWani then joins it with the chat embed's events on site, user agent and path alone, which is less exact.

## When WaniWani is slow or down

Your site does not notice. The post runs after the response, inside the `waitUntil` of your platform, with a 2 second timeout. After a network error, a timeout, a 429 or a 5xx it tries once more after 500 ms. Any other 4xx gets no retry. If the second try fails as well, the library writes one line to your function logs and drops the event. It never throws.

## Dependencies

The package has no runtime dependencies. The IP range check uses `BlockList` from `node:net`. On Vercel it finds `waitUntil` by itself, in the request context that the Vercel runtime sets for each request. On other platforms you pass `waitUntil` in the options. The bot list, the IP ranges and the match code ship inside the package, and the library never downloads code. To get a newer bot list, upgrade the package.

## Cloudflare Workers

The library imports `node:net` for its IP range check, so a Worker needs the `nodejs_compat` flag. Workers with a compatibility date of 2026-08-04 or later have it on by default.

A Worker on a route sees each request to the pages of that route before your site does. Create a Worker project with `npm create cloudflare@latest`, add `@waniwani/relay` to its dependencies, and put this code in `src/index.ts`:

```ts
import { isAgent, recordAgentVisit } from "@waniwani/relay";

export default {
  async fetch(request, env, ctx) {
    if (isAgent(request)) {
      recordAgentVisit(request, {
        key: env.WANIWANI_AGENT_TRAFFIC_KEY,
        waitUntil: ctx.waitUntil.bind(ctx),
      });
    }
    return fetch(request);
  },
} satisfies ExportedHandler<{ WANIWANI_AGENT_TRAFFIC_KEY: string }>;
```

`return fetch(request)` passes the request on to your site as it came. If a Worker already runs on these pages, add the `if` block at the top of its `fetch` handler. A Worker has no `process.env`, so pass the key and `waitUntil` yourself.

The routes in `wrangler.jsonc` pick the pages that go through the Worker:

```jsonc
{
  "name": "waniwani-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": ["www.example.com/*"]
}
```

Then store the key as a secret and deploy:

```bash
npx wrangler secret put WANIWANI_AGENT_TRAFFIC_KEY
npx wrangler deploy
```

## Other platforms

Pass the key and `waitUntil` in the options. Without a `waitUntil`, the post may stop when your platform ends the request.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `region` | `"us"` | The region of your organization: `"us"` sends to `https://app.waniwani.ai`, `"eu"` to `https://eu.app.waniwani.ai` |
| `apiUrl` | The host of `region` | Another WaniWani host, for local development |
| `key` | `process.env.WANIWANI_AGENT_TRAFFIC_KEY` | The key from the setup screen, `wwt_<token>.<org key>` |
| `waitUntil` | Found by itself on Vercel, none on other platforms | Keeps the post alive after the response |
| `omit` | `[]` | Headers and fields to leave out of every event |

## Development

```bash
bun install
bun run build   # typecheck, lint and dist/index.js
bun run test    # unit tests (run the build first, one test imports dist)
bun run rules   # refreshes src/logic/ip-ranges.generated.json from the vendors' published lists
```

`src/logic/agents.json` is copied by hand from the WaniWani bot catalog (`src/lib/agent-traffic/bot-catalog.ts` in the WaniWani app): every entry of kind `training`, `search` or `fetcher`, using its `token` when it has one and its lowercased name otherwise.

## License

[Apache 2.0](LICENSE)
