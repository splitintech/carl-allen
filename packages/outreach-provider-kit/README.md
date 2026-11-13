# @splitin/outreach-provider-kit

Shared building blocks for outreach provider adapters: JSON HTTP with send-outcome classification, loopback OAuth (PKCE), delivery-status parsing.

Development version 0.0.0; not yet a published release. Requires Node 22.13+.
See the [engine README](../../README.md), [build plan](../../BUILD_PLAN.md),
[runbook](../../docs/runbook.md) and [release gates](../../docs/release.md).

Build from the workspace root with `npm run build`; verify with `npm run check`.
The engine keeps human approval, suppression and live-send gates in the core.
Do not call provider send methods outside the durable execution pipeline.

MIT license.

## Shared OAuth loopback helper

The public API delegates to the versioned MIT `@splitin/spiderman-oauth-loopback` module from [Spiderman alpha.2](https://github.com/splitintech/spiderman/releases/tag/v0.1.0-alpha.2). Its adapter preserves the existing page title and immediate wrong-state rejection. PKCE, token exchange callbacks and campaign orchestration remain at their existing boundaries. The shared package supplies ESM and CommonJS entry points without depending on a provider execution runtime.
