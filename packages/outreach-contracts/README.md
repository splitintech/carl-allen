# @splitin/outreach-contracts

Provider-neutral outreach contracts: types, schemas, action state table, error taxonomy.

Development version 0.0.0; not yet a published release. Requires Node 22.13+.
See the [engine README](../../README.md), [build plan](../../BUILD_PLAN.md),
[runbook](../../docs/runbook.md) and [release gates](../../docs/release.md).

Build from the workspace root with `npm run build`; verify with `npm run check`.
The engine keeps human approval, suppression and live-send gates in the core.
Do not call provider send methods outside the durable execution pipeline.

MIT license.

## Shared MIME transport

MIME composition delegates to the versioned MIT `@splitin/spiderman-mail-mime` module from [Spiderman alpha.2](https://github.com/splitintech/spiderman/releases/tag/v0.1.0-alpha.2). The compatible adapter retains the approved-email input, legacy `X-Outreach-Key` header, MIME error type and boundary prefix. The dependency contains no campaign or agent execution engine. The public archive URL and lockfile integrity make installation independent of a local Spiderman checkout.
