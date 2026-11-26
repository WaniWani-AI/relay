# Relay protocol

This file tells how a relay talks to Waniwani. Use it when you write a port of the relay in a new language. The TypeScript relay in `src/` is the reference. The JSON files in `fixtures/` give the exact behaviour, and each port must give the same output for each case. Run `bun run fixtures` to write them again from the TypeScript code.

## Key

The setup screen gives a key in the format `wwt_<ingestToken>.<orgKey>`. A valid key agrees with this expression, after you trim it:

```
^wwt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+={0,2})$
```

The ingest token goes in URLs. The org key never leaves the server. If the key is not valid, the relay writes one warning and does nothing. Cases: `fixtures/key.json`.

## Hosts

| Region | API URL |
| --- | --- |
| `us` | `https://app.waniwani.ai` |
| `eu` | `https://eu.app.waniwani.ai` |

## Endpoints

| Call | Request | Answer |
| --- | --- | --- |
| Agent rules | `GET {api}/api/v2/agent-traffic/rules` | `{ "data": { "version": 1, "tokens": [...], "ipRanges": [{ "ipv4": [...], "ipv6": [...] }] } }` |
| Site rules | `GET {api}/api/v2/agent-traffic/serve/{ingestToken}/rules` | `{ "data": <site rules> }`. Cases: `fixtures/site-rules.json`. |
| Ingest | `POST {api}/api/v2/agent-traffic/ingest/middleware/{ingestToken}` with `content-type: application/json` and body `{ "requests": [<record>] }` | 2xx |
| Agent page | `GET` or `POST {pagesUrl}/{hostname}{path}?{query}` | 200 with the page, or 429 for `/ask` |

### Agent rules

- Refresh each 12 hours. After a failed fetch, try again after 5 minutes.
- If `data.version` is not 1, or a field has the wrong type, keep the current rules.
- If a CIDR is not valid, keep the current rules.
- Lowercase each token.
- Until the first fetch succeeds, use the rules in `src/logic/*.generated.json`. A port embeds the same two files.

### Site rules

- The first fetch for a key waits 300 ms maximum. If it fails, the request gets no agent page, and the next fetch can start after 5 seconds.
- After the first success, the relay answers from memory. When the copy is 60 seconds old, one background fetch starts. Only one fetch for each key runs at a time.
- A request with no site for its hostname gets no agent page.

### Ingest

- Timeout 2 seconds.
- On a timeout, a network error, 429 or 5xx, wait 500 ms and send one more time. Then discard the record.

## Detection

A request is from an agent when one of these is true. Cases: `fixtures/decide.json`.

1. The first 1024 UTF-16 code units of the `user-agent` header, in lowercase, contain a token.
2. The request has a `signature-agent` header, also when it is empty.
3. The request has a `dpop` header.
4. The `authorization` header, reduced to its scheme name (see below), is `DPoP`.
5. The client IP is in an AI IP range. An IPv4-mapped IPv6 address also matches the IPv4 ranges. An address that is not valid does not match.

## Headers

The relay reads and sends only these 13 request headers: `user-agent`, `referer`, `accept`, `accept-language`, `from`, `signature-agent`, `signature-input`, `signature`, `dpop`, `sec-ch-ua`, `sec-ch-ua-platform`, `sec-ch-ua-mobile`, `authorization`. Join repeated headers with `, `.

For `authorization`, keep only the scheme name, and only when a credential follows it. The known schemes are `Basic`, `Bearer`, `Digest`, `DPoP`, `HOBA`, `Mutual`, `Negotiate`, `NTLM`, `OAuth`, `PrivateToken`, `SCRAM-SHA-1`, `SCRAM-SHA-256`, `vapid` and `AWS4-HMAC-SHA256`. Compare them without case, and send the spelling in this list. Drop any other value. Cases: `fixtures/headers.json`.

## AI referrals

A request is an AI referral when it is not from an agent (see [Detection](#detection)) and the host of its `referer` header is an AI assistant. Cases: `fixtures/record.json`, the cases with `referer` hosts below.

1. Trim the `referer` value and parse it as an absolute URL. If it is not a URL, it is not an AI referral.
2. The scheme must be `http`, `https` or `android-app`.
3. The lowercase host, without user, password and port, must be one of `chatgpt.com`, `chat.openai.com`, `com.openai.chatgpt`, `claude.ai`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com` and `meta.ai`, or end with `.` and one of them.
4. The referer origin is `<scheme>://<host>/`, for example `https://chatgpt.com/` or `android-app://com.openai.chatgpt/`.

## Client IP

On a fetch platform, the relay reads `cf-connecting-ip`, then the first `x-forwarded-for` entry, then `x-real-ip`. The platform writes these headers, so the client cannot set them.

A server behind its own proxies uses this rule instead. Cases: `fixtures/client-ip.json`.

1. Without a configured client IP header, use the peer address.
2. With a configured header, use it only when the peer address is a trusted proxy.
3. Read a list header from the right. Use the first entry that is not a trusted proxy. If an entry is not an IP address, use the last trusted address before it. If all entries are trusted, use the leftmost entry.
4. Remove a port and IPv6 brackets. Trim the result and change it to lowercase.

## Match key

The lowercase hex of HMAC-SHA256. The HMAC key is the UTF-8 bytes of the org key. The message is the UTF-8 bytes of the client IP. Cases: `fixtures/match-key.json`.

## Record

```json
{
	"occurredAt": "2026-11-23T10:00:00.000Z",
	"method": "GET",
	"host": "www.example.com",
	"path": "/pricing?x=1",
	"userAgent": "...",
	"referer": "...",
	"headers": { "user-agent": "..." },
	"matchKey": "64 hex characters",
	"sourceEventId": "a random UUID",
	"relayVersion": "0.7.0",
	"platform": "aspnet",
	"uses": ["recordAgentVisit", "serveAgentPage"]
}
```

- `host` is the hostname in lowercase, without the port. `path` is the path and the query.
- Leave out `userAgent`, `referer`, `matchKey` and `platform` when there is no value. The ingest refuses fields that it does not know.
- `relayVersion` is the TypeScript release whose fixtures the port passes.
- `uses` lists the relay functions that the process called.
- The `omit` option removes headers, and the fields `userAgent`, `referer` and `matchKey`. Compare the names without case. `userAgent` also removes the `user-agent` header.
- For an AI referral, `headers` is `{}`, `path` has no query, `referer` is the referer origin, `visitor` is `"aiReferral"`, and there is no `matchKey`. The `omit` option still removes `userAgent`. When `omit` names `referer`, send no record. Leave out `visitor` for an agent.

Cases: `fixtures/record.json`. They leave out `occurredAt`, `sourceEventId`, `uses` and `platform`, because these change for each run or each port.

## Agent pages

Cases: `fixtures/serve.json`, `fixtures/accept.json` and `fixtures/paths.json`.

1. Only `GET`, `HEAD`, and `POST` on the path `/ask` can get an answer. The request must be from an agent, or from a client that prefers Markdown.
2. Find the site for the hostname in the site rules.
3. If the lowercase `user-agent` contains a blocked token of the site, answer 403. This applies also to a request with `x-waniwani-render`.
4. A request with `x-waniwani-render` comes from the Waniwani page renderer. Give it to the site.
5. The site must have agent pages on, and the path must agree with a pattern. Remove trailing slashes from the path first, except for the root. `/products/*` agrees with `/products` and all paths below it. `*` and `/*` agree with all paths.
6. A user agent that contains a token from `userAgentTokens` gets the format that it asks for: Markdown when `accept` names `text/markdown` with a q above 0, else HTML. Another client gets Markdown only when it prefers Markdown. That is, `text/markdown` has a q above 0 and not lower than the most specific range that covers `text/html`. Parse q like JavaScript `Number()`. A value that is not finite counts as 0.
7. For `POST /ask`, read the body. If it is empty, or longer than 16,384 bytes, give the request to the site. The site must still be able to read the body.
8. Fetch the page. Send `accept: text/markdown` or `accept: text/html`, `x-waniwani-relay: <version>`, and `x-waniwani-agent: <user agent>` when the user agent is not empty. For `/ask`, send the body with `content-type: application/json`. The root path has no slash after the hostname.
9. Wait `headersMs` for the headers (`askMs` for `/ask`, default 3000), then `bodyMs` for the body. The body must not be longer than `maxBodyBytes`.
10. Accept only a 200 with a `text/*` content type, or `application/json` on `/ask`, `/.well-known/ai-catalog.json`, `/openapi.json`, `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json`. On `/ask`, also pass a 429 with its `retry-after`.
11. The answer has the content type of the page, `x-waniwani-agent-page: hit`, `cache-control: private, no-store` and `vary: user-agent, accept`. A 403 has `content-type: text/plain; charset=utf-8`, `x-waniwani-blocked: 1`, `cache-control: private, no-store`, `vary: user-agent` and the body `Forbidden`. A `HEAD` gets no body.

In all other cases, and after any error or timeout, the site gives its usual response.

## End-to-end tests

`bun run e2e --target <site URL>` sends real HTTP requests to a site that runs a port, and checks the answers and the records. See `e2e/README.md`.
