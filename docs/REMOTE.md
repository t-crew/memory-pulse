# memory-pulse as a remote MCP server

`memory-pulse http` serves the four tools (pulse, recall, remember, execute) over MCP's Streamable HTTP transport, for a
client that only takes a URL: a claude.ai custom connector (Claude on the web, desktop and phone, and apps built on it),
or any MCP client that speaks HTTP. The stdio server is unchanged; this is a second way in to the same memory.

## What runs where

- **Memory** is the project's hosted ledger on the engine, the one `memory-pulse state push` and `state pull` move
  between your machines. The HTTP server keeps no ledger of its own. Hosted memory needs a paid plan's project key.
- **Your key** is typed once, on the server's own sign-in page. It is kept only inside the access and refresh tokens the
  server encrypts (AES-256-GCM under `MEMORY_PULSE_HTTP_SECRET`) and the client holds. The server has no token store, no
  database and no log line with a key or token in it.
- **Each tool call** runs in a fresh child process whose environment holds that one person's key and project and a
  temporary folder, and nothing else (not the server's secret). It pulls the hosted ledger, runs the call through the
  same code the stdio server runs, pushes after a `remember`, and deletes the folder. Calls for one person run one at a
  time, so two writes cannot race; calls for different people never share a process, a folder or a variable.
- **remember** writes to the hosted ledger. If the engine refuses the write, the tool says the row was not kept. The
  agent scope (`--scope agent`) is not offered, because the agent ledger lives in the home folder of a machine.

## Sign-in

OAuth 2.1 with PKCE (S256) and dynamic client registration, which is what claude.ai custom connectors use:

| path | what |
|---|---|
| `/mcp` | the MCP endpoint; answers 401 with `WWW-Authenticate` until the client has a token |
| `/.well-known/oauth-protected-resource` | points the client at the sign-in server (this one) |
| `/.well-known/oauth-authorization-server` | the sign-in server's endpoints |
| `/register` | dynamic client registration; redirect URIs must be https (http only on localhost) |
| `/authorize` | the sign-in page: project key and project name |
| `/token` | code (with the PKCE verifier) for tokens; refresh |
| `/healthz` | liveness |

Access tokens last an hour and refresh tokens 30 days. A code works once (per running copy) and for five minutes.
Changing `MEMORY_PULSE_HTTP_SECRET` signs every client out. Revoking the project key in the console ends access the
next time the engine is asked, whatever token a client still holds.

## Run it

```
MEMORY_PULSE_HTTP_SECRET="$(openssl rand -hex 32)" \
MEMORY_PULSE_HTTP_URL=https://mcp.example.com \
npx -y memory-pulse http
```

It listens on `PORT` or `MEMORY_PULSE_HTTP_PORT` (default 8787) and needs Node 18 or newer with `child_process` and a
writable temporary folder: a container or VM host such as Fly.io, Render, Railway or a small server. It does not run
on Cloudflare Workers. Put it behind TLS; `MEMORY_PULSE_HTTP_URL` must be the https address clients use, without a
path. The `Dockerfile` in the repository runs it as is. Keep the secret in the host's secret store, never in the repo.

To try it locally, `MEMORY_PULSE_HTTP_SECRET=... npx -y memory-pulse http` serves `http://localhost:8787/mcp`, which
the MCP Inspector can reach.

## Add it to Claude

In claude.ai, Settings, Connectors, add a custom connector with the URL `https://<your host>/mcp`. Leave the OAuth
client fields empty (the server registers clients itself). Connect, then on the sign-in page paste a project key from
the console and name the project. To share memory with a project on your computer, use the name it has there: its
folder name, or `MEMORY_PULSE_PROJECT`.
