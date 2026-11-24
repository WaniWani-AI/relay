# End-to-end tests

These tests send real HTTP requests to a site that runs a port of the relay. They check the answer that the client gets and the records that get to Waniwani. They do not know the language of the port, so the same tests check each port.

```
node e2e/run.ts --target http://127.0.0.1:8080
```

The runner starts:

- a fake Waniwani server on port 4600, with the agent rules, the site rules, the ingest endpoint and the agent page service. Point the site at it with `Waniwani:BaseUrl`.
- a proxy on port 8081 that acts like a CDN. It connects to the site from `--proxy-source` (default `127.0.0.2`) and adds the client IP to `X-Forwarded-For`. Configure the site with `ClientIpHeader=X-Forwarded-For` and `TrustedProxies=127.0.0.2`.

The site must answer each path with HTML and the header `x-origin: 1`, `POST /ask` with `ask-origin:<body bytes>`, and `POST /form` with `form:<name field>`. It must serve `/llms.txt` as a static file. `dotnet/samples/SampleSite` is such a site for IIS.

| Option                                                                                             | Use                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--suite default`                                                                                  | All the tests in the design document. `disabled` and `bad-key` run the tests for `Waniwani:Enabled=false` and for a key that is not valid. |
| `--slow`                                                                                           | Also runs the tests that take more than a minute (F5, L2).                                                                                 |
| `--restart-cmd <command>`                                                                          | A command that recycles the site. Needed for F3 and L1.                                                                                    |
| `--memory-cmd <command>`                                                                           | A command that prints the memory of the site process in bytes. F5 uses it.                                                                 |
| `--only D1,D2`                                                                                     | Runs only these tests.                                                                                                                     |
| `--live --target https://staging.example.com --page-path /x --no-page-path /y --blocked-ua GPTBot` | Runs the live tests against a real site with real Waniwani. Check the records in the Waniwani app.                                         |

`node e2e/load.ts --with <site with the relay> --without <same site without it>` measures the time that the relay adds to requests from persons.

`bun run e2e:ts-target` starts the TypeScript relay as a target on port 8090, to check the runner itself.
