# satori-mcp

Stdio MCP server for Satori CI, a TypeScript port of the `satori-v2 mcp` server from
`cli-v2` (same tools, resources, prompt, output shaping and error messages).

## Install

Run it straight from GitHub (npm clones the repo and builds it through the `prepare` script):

```sh
npx -y github:satorici/satori-mcp
```

MCP client config:

```json
{ "mcpServers": { "satori": { "command": "npx", "args": ["-y", "github:satorici/satori-mcp"] } } }
```

Pin a version with `github:satorici/satori-mcp#<tag-or-sha>`. npx caches git installs, so to
pick up new commits on `main` use an explicit ref or clear the cache (`npm cache clean --force`).

## Develop

```sh
pnpm install          # also builds dist/ (prepare)
pnpm build            # tsc -> dist/
pnpm test             # vitest
```

Local build config: `{"command": "node", "args": ["/path/to/satori-mcp/dist/index.js"]}`.

Credentials are shared with the CLI: `~/.satori_credentials.yml` profiles (`--profile X` or
`SATORI_PROFILE`), overridden by `SATORI_*` env vars (e.g. `SATORI_TOKEN`). Endpoints:
`SATORI_ENDPOINT`, `SATORI_PLAYBOOKS_ENDPOINT`, `SATORI_DASHBOARD_URL`, `SATORI_DOCS_URL`.

## Layout

| File | Role |
|---|---|
| `src/server.ts` | Tool/resource/prompt registration, instructions, descriptions |
| `src/tools.ts` | Tool handlers (`safe` turns API errors into `{error}` objects) |
| `src/shaping.ts` | Caps and summaries applied to every response |
| `src/recommend.ts` + `data/recommendations.yaml` | `recommend_playbook` stack detection and rules |
| `src/local/` | `run_local` engine: recipe runner, result substitution, upload |
| `src/api.ts`, `src/config.ts`, `src/bundle.ts`, `src/git.ts` | API client, CLI-compatible config, playbook bundles, shallow clones |

stdout is the protocol channel: nothing may print to it.

`recommend_playbook` does not run the Python playbook validator. The test suite checks the
structure of the generated playbooks, and the generated YAML was verified once against
`satorici.validator`.
