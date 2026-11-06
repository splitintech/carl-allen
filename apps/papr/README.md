# Outreach Console for Papr Work

An optional, local-desktop console for the independently running outreach engine: content drafts and schedules, LinkedIn messages and connections, configured browser tasks, mailbox drafts, approvals, review, campaign health and a workspace kill switch.

**Status: compatibility preflight, not a validated Papr release.** The current contract baseline is Papr development commit [b34b6c4](https://github.com/Papr-ai/paprwork/commit/b34b6c4090adfb64109004d1a25645a3d3a2bd66), alongside release 2.7.2. Clean desktop import, the full `validate_app` workflow and worker execution inside Papr remain pending. The manifest's declared 2.6.0 floor is not a tested minimum. See [acceptance checklist](docs/ACCEPTANCE.md) and [provenance](compatibility.json).

## Boundaries

- The engine retains its own SQLite database and transactional/audit boundary. The console accesses only its HTTP API, not Papr registry databases. [ADR 0004](../../docs/adr/0004-papr-host-integration.md) records the original decision; this does not imply current Papr lacks atomic database operations.
- Browser modules call `/api/app/backend/:action`. The allowlisted backend handler injects the API token server-side and forwards fixed API routes. Backend/engine roles remain authoritative.
- The bundle depends on a separate engine process. Preferred production placement is a Daytona sandbox (`deploy/daytona`): set `OUTREACH_API_URL` to that sandbox's **private preview HTTPS URL** and keep the API token server-side. Loopback (`http://127.0.0.1:8787`) remains valid for local acceptance. Social Chrome never runs on the Mac (ADR 0006). Keep cloud publishing and sharing disabled. `sync.cloudReady: false` is descriptive metadata, not an enforcement guarantee.
- Optional job code runs a configured local CLI once. It never installs or downloads dependencies. Its schedule is disabled by default.
- The in-app confirmation dialog is ordinary UI, not trusted MCP/agent-host approval. Human decisions must still follow the engine's authorization requirements.

## Local prerequisites

Use Node 24 for the Papr compatibility baseline. In the engine workspace, install its normal workspace dependencies and build it using the engine's [instructions](../../README.md). The built entry is `packages/outreach-cli/dist/bin.js`; its workspace dependencies must remain available. Do not assume an npm registry release exists.

Initialize a separate test database and start `outreach serve` on loopback. Configure a test principal/token with the intended role. Begin with fake providers, an empty audience and live sending closed. Never put tokens or real contacts into the exported bundle, screenshots or test evidence.

## Import and connect

1. Import the local `bundle/` folder into Papr Work. Record the exact Papr version and OS. Keep the app private and cloud publishing disabled.
2. Prefer `OUTREACH_CONNECTION_FILE` pointing to the private connection JSON created by `deploy/daytona/manage.py`. The backend re-reads it on every action, so refreshed preview credentials and live-view links take effect without reimporting. The file must be regular, owner-only (`chmod 600`), and contain `apiUrl`, `apiToken`, and `previewToken`; `liveViewUrl` is optional. Keep it outside the bundle.
   Alternatively configure `OUTREACH_API_URL`, `OUTREACH_API_TOKEN`, and `OUTREACH_PREVIEW_TOKEN` separately. The preview token authenticates the Daytona proxy, while the API token authenticates the engine. Never substitute one for the other. Optional `OUTREACH_DAYTONA_LIVE_VIEW_URL` supplies the sign-in link. All keys are injected server-side.
   Refresh credentials with `python deploy/daytona/manage.py refresh --state /absolute/private/daytona-connection.json`, or keep them current with `python deploy/daytona/manage.py watch --state /absolute/private/daytona-connection.json --interval 300`. Use a viewer-role engine token when validating read-only behavior.
3. Confirm the imported app ID. The frontend accepts `?appId=<assigned-id>`, then `document.documentElement.dataset.appId`, then `outreach-console` as its fallback.
4. Verify overview data and role failures before enabling any mutation-capable account. Run `validate_app` and work through [ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Optional worker

The preferred independent engine worker can run outside Papr. To test the optional Papr job instead, configure its environment with:

- `OUTREACH_CLI_ENTRY`: absolute path to a trusted, regular, non-symlink built `packages/outreach-cli/dist/bin.js` file. Relative paths and HTTP/file URLs are rejected.
- `OUTREACH_DB`: absolute path to the initialized test engine database.
- `OUTREACH_HOME`: absolute engine home, if different from `$PAPR_HOME/outreach` (or `~/Papr/outreach`). An existing `outreach.config.mjs` there is passed to the trusted CLI.
- `OUTREACH_WORKER_TIMEOUT_MS`: optional deadline, 100–300000 milliseconds; default 120000. Cancellation or timeout terminates the child. Child stdout/stderr is suppressed to avoid leaking provider data; job output contains only status and redacted diagnostics.

Set the job to local-only and verify its actual execution location before running it. First run one pass with fake providers. Only enable scheduling after live acceptance and explicit operator setup; do not run both this schedule and another worker unintentionally. The wrapper has no package.json or package-install step. It does not remove the engine's separate build/dependency requirement.

## Included files

- `bundle/apps/outreach-console/`: browser entry, small `ui/` modules, styles and backend actions.
- `bundle/jobs/outreach-worker/code/run.mjs`: dependency-free optional local entry wrapper.
- `bundle/skills/outreach.md`: recommended agent operating guidance. Bundle import has not been verified to register this as an active skill; do not rely on its mere presence as enforcement.
- `src/`: engine-API contract, browser test-double, wrapper and compatibility tests.

Run `npx vitest run apps/papr/src` from the engine workspace after installing its normal dependencies. These are local tests, not a Papr desktop test.

## Contribution route

Keep the engine in its own repository. Seek maintainer agreement before proposing a small Papr integration/example or reusable host fix. The [community-apps guide](https://github.com/Papr-ai/paprwork-community-apps/blob/12fae6e6a4d5a367236c78bd701b876a404958e3/CONTRIBUTING.md) prohibits new listing PRs; rare curated offline templates require approval and normally no external dependencies. Do not publish this local-only bundle as a cloud app to bypass that requirement.

## Authoring and account connections

**Accounts & connections** can stay empty until you are ready. Choose **Connect LinkedIn account**, enter your identity, then follow the guided browser login and session check. **Set up later** closes setup without registering anything; after registration, **Finish later** keeps the account so you can resume from its card. Connection errors remain recoverable in the form.

Connect LinkedIn with an admin-role token and your canonical `https://www.linkedin.com/in/<profile>/` URL. The runtime creates a separate persistent profile binding. Open live view, sign in within Daytona, then choose **Check session after login**. A newly created Chrome process can take several seconds to become ready. Account bindings cannot silently switch to a different identity. No local Mac profile or cookies are imported.

**Create a post** saves a content draft. Edit drafts, then choose **Schedule for approval** to materialize posts. The default composer uses business hours in your selected time zone with low daily caps. Editing a scheduled post invalidates its old approval and requires a fresh decision. Cancel or convert a held post to a manual task when appropriate. Optional HTTPS image URLs must be on the runtime's approved media hosts and are included in the approval.

**Schedule message or browser action** queues a LinkedIn DM, connection request, or administrator-configured browser task. Browser tasks are restricted to trusted recipe definitions; their exact recipe hash and inputs are approved. Unsupported platforms and unconfigured tasks fail explicitly. **Connect configured browser account** registers an account already defined by the administrator with trusted recipe identity rules; it cannot create arbitrary selectors or origins from the form. Existing outreach playbooks support per-step `providerAccountId` for mixed mailbox/social sequences.

**Set up Gmail** and **Set up Outlook** explain the required administrator OAuth setup; they do not pretend browser login grants mailbox access. The console does not yet initiate mailbox OAuth consent. After the administrator connects a mailbox, refresh to see it under Connected accounts and Mailbox drafts. No credential fields are exposed in account setup.

**Mailbox drafts** loads, creates, edits, and deletes drafts in Gmail or Outlook through their mailbox APIs. These actions never call a send endpoint or enqueue an email send. Gmail edits preserve reply headers; existing attachment/CC/BCC drafts are refused before mutation and can be edited in Gmail. Gmail grants need `gmail.compose` in addition to existing send/read permissions; reconnect older grants to consent to this scope. Email sending remains an explicitly scheduled engine workflow.

Use CLI `calendar drafts|get|edit|delete`, `action schedule|edit|cancel|manual`, `account reconnect`, and `drafts list|get|save|delete` for the same operator functions. HTTP mutations enforce engine roles, workspace ownership and fresh approvals. The console's ordinary UI confirmations do not grant elevated roles.

The gated real Chrome fixture uses a fresh temporary profile and intercepted static/API responses: `OUTREACH_BROWSER_FIXTURES=1 npx vitest run apps/papr/src/console-chrome.test.ts`. It establishes browser-level UI behavior, not an installed Papr release or live provider acceptance. Clean Papr import and live signed-in Daytona acceptance remain separate gates.

## Four-platform Publishing Studio

The default bundle entry is now Publishing Studio: LinkedIn, X, Instagram and TikTok composition, private image/video upload, platform previews, calendar, drafts, approval queue and stop/resume. The original outreach/email console is linked. See [Publishing Studio guide](docs/PUBLISHING_STUDIO.md) for supported formats, single-file HTML, trusted backend setup and deployment/acceptance boundaries. New endpoints require the updated engine; the older deployed image is unchanged by importing UI files.
