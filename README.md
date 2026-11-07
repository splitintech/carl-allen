<p align="center"><img src="docs/brand/splitin-logo.png" alt="SplitIn" width="96" height="96"></p>

# Carl-Allen

A private publishing and outreach workspace with HTML handoffs, a dark calendar/composer,
Google team access, monthly plan approvals and Daytona execution.

Provider-neutral outreach orchestration with durable state, explicit human approval,
reply/opt-out handling and an append-only audit log. Import contacts, compile versioned
playbooks into scheduled actions, and execute them through capability-checked adapters.
The CLI, HTTP API, local MCP server and Papr console are clients of the same engine.

## Status and distribution

This standalone repository includes the engine workspace and the later Papr compatibility
changes. It contains provider-neutral npm packages, a private end-to-end test package
and a private Papr application. The workspace root itself is private.

All public packages currently use development version `0.0.0`. No npm publication or
production deployment is implied. Use local builds and packed artifacts for development.
Live Gmail/Outlook acceptance, Papr desktop acceptance and host-specific MCP acceptance
remain separate release gates. Papr's optional local worker remains disabled by default;
authenticated remote MCP is included in the deployable gateway. Cloudflare deployment is performed by the workspace owner. See [the deployment guide](deploy/cloudflare/README.md) and [requirement evidence](docs/plans/carl-allen-requirements.json).

## Behavior and boundaries

- Durable action state, provider reconciliation and an auditable transition history.
- An uncertain send outcome is held until reconciled, rather than automatically repeated.
- Reply, bounce, opt-out, suppression, pause, expired approval and unhealthy account checks.
- Imports from CSV, JSON, inert HTML and XLSX through isolated parsing packages.
- Versioned playbooks, template rendering, approval and campaign execution controls.
- Gmail and Outlook adapters, Slack notifications and local stdio MCP.
- Verified Daytona browser publishing on LinkedIn, X, Instagram and TikTok, with independent account identities.
- Reviewed LinkedIn/Instagram browser outreach, coordinated sequences, inboxes and deterministic reply playbooks.
- Zoho read/draft OAuth adapter; sending stays manual in Zoho.
- Inert HTML manifests/guided repair, R2 immutable media, 90-day plans and one self-contained HTML interface.
- Models may draft or propose work; deterministic engine code controls execution.

A provider adapter being present does not establish live account configuration or acceptance.
The admin-controlled live-send gate stays part of the engine. Do not bypass it by invoking
adapter send functions directly.

## Requirements and quick start

Use Node.js **24** for the cloud gateway; engine packages also support **22.13 or later** (including built-in `node:sqlite`) and npm.
No live provider credentials are needed for fake-provider tests.

```sh
git clone https://github.com/splitintech/carl-allen.git
cd carl-allen
npm ci
npm run build
mkdir -p .test-tmp
TMPDIR="$(pwd -P)/.test-tmp" npm run check
npm run soak
npm run mcp:smoke
npm run release:verify -- --allow-unreleased
npm run check:packed
```

The explicit temporary directory avoids macOS symlink aliases rejected by the backup
path checks. Use a physical checkout path (`pwd -P`).

The build script orders workspaces by their dependencies. `check` runs lint, TypeScript,
tests, package-boundary rules, secret checks and source-size checks. `soak` exercises
synthetic durable execution. `mcp:smoke` starts a real local subprocess with a temporary
synthetic database; it does not send email or qualify a particular desktop host.

After building, initialize a local database through the CLI:

```sh
node packages/outreach-cli/dist/bin.js init --db /absolute/path/outreach.db
```

Use [the runbook](docs/runbook.md) for account configuration, import, campaigns, approvals,
workers, server operation, backups and incident recovery. Local state and credentials
must stay outside Git and package artifacts.

## Packages

| Package | Milestone | What it is |
| --- | --- | --- |
| `@splitin/outreach-contracts` | M0 seed, M1 | Types, schemas, action transition table, error taxonomy, provider ports |
| `@splitin/outreach-fakes` | M1 | Fake providers with failure modes + provider conformance kit |
| `@splitin/outreach-store-sqlite` | M2 | Migrations, repositories, audit hash chain |
| `@splitin/outreach-core` | M3–M4, M6 | Execution core, campaign domain, policy, inbound processing |
| `@splitin/outreach-import` | M5 | Inert HTML/CSV/XLSX/JSON importer |
| `@splitin/outreach-e2e` (private) | M6 | Import-to-audit end-to-end suite on fake providers |
| `@splitin/outreach-server` | M7 | HTTP API: bearer tokens, webhooks, one-click unsubscribe |
| `@splitin/outreach-cli` | M7 | The `outreach` command (setup, imports, campaigns, approvals, worker, serve) |
| `apps/papr` | M7 | Papr Work bundle: Outreach Console mini-app, worker job, agent skill |
| `@splitin/outreach-mcp` | M9 | MCP server |
| `@splitin/outreach-provider-email-gmail` | M8 | Gmail adapter: send as the mailbox user, Sent-folder reconciliation, History API inbound, loopback OAuth |
| `@splitin/outreach-provider-email-outlook` | M8 | Outlook / Exchange Online adapter via Microsoft Graph: MIME draft-then-send, Sent Items reconciliation, rotating refresh tokens |
| `@splitin/outreach-provider-kit` | M8 | Shared adapter building blocks: HTTP outcome classification, loopback OAuth (PKCE), DSN parsing |
| `@splitin/outreach-notify-slack` | M8 | Slack notifications: incoming webhook or `chat.postMessage`, escaped Block Kit |
| `@splitin/outreach-provider-email-zoho` | Cloud workspace | Regional OAuth, inbox/thread reads and draft CRUD; no sending port |


The package table retains milestone labels for traceability. Current implementation and
remaining acceptance boundaries are described above and in the linked package READMEs.

## Architecture and package use

`outreach-contracts` defines the shared ports and types. Core orchestration, import and
provider adapters use those contracts; SQLite, HTTP, MCP, Slack and parsing dependencies
remain in the packages that own them. `npm run boundaries` enforces that separation.
Keep the engine packages together in this repository and release compatible versions
in dependency order.

A consumer installs the subset it needs: for example, core/contracts plus a store and
provider for embedding, the CLI for local operations, or the MCP server for an agent host.
The command-line/server/storage packages require Node; they are not browser libraries.
The Papr bundle has its own desktop compatibility and acceptance requirements.

## Local MCP and Papr

After a versioned package installation provides `outreach-mcp`, a host configuration is:

```json
{
  "mcpServers": {
    "outreach": {
      "command": "outreach-mcp",
      "args": ["--db", "/absolute/path/outreach.db", "--workspace", "default"]
    }
  }
}
```

For source development, launch `node /absolute/path/outreach-engine/packages/outreach-mcp/dist/bin.js`
with the same arguments. Initialize the database as the local OS user first. The MCP
server exposes ten tools and requires human confirmation for committing prepared changes;
clients without the required confirmation capability can preview but cannot commit.
It does not launch a worker, load provider secrets or expose a TCP listener.

See [MCP behavior and limits](packages/outreach-mcp/README.md),
[Papr setup](apps/papr/README.md) and [Papr acceptance](apps/papr/docs/ACCEPTANCE.md).
The Papr compatibility additions preserve `cloudReady: false`; a compatible manifest is
not evidence of a completed desktop import or live job execution.

## Repository guide

| Path | Contents |
| --- | --- |
| `packages` | Public library/CLI/server/adapters and private E2E suite |
| `apps/papr` | Papr bundle, local worker wrapper and compatibility tests |
| `scripts` | Ordered builds, boundaries, soak, package and release checks |
| `docs/adr` | Architecture and provider-policy decisions |
| `docs/runbook.md` | Setup, operations and recovery |
| `BUILD_PLAN.md` | Original scope and acceptance milestones |

## Packaging and release

`npm run check:packed` installs all public tarballs into a fresh consumer and verifies
exports plus local CLI/MCP operation. `release:verify -- --allow-unreleased` checks the
development artifacts without allowing publication of `0.0.0`.

Before release, assign one coordinated version, update internal dependency versions,
complete the applicable external acceptance checks, configure npm trusted publishing for
all public packages and enable the repository publication gate. The publish workflow
requires the established verified signed annotated tag and protected release environment.
See [release preparation](docs/release.md), [maintenance](docs/maintenance.md) and
[threat model](docs/threat-model.md).

## Contributing and provenance

See [CONTRIBUTING.md](CONTRIBUTING.md), [migration provenance](docs/migration.md),
[validation record](docs/migration/validation.json), and [release setup](docs/repository-release.md).
Relevant Git history, source inventories, original licenses and artwork are retained.
The migration does not publish packages, configure credentials or deploy infrastructure.

## License

MIT. See [LICENSE](LICENSE).
