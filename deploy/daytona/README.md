# Durable Daytona browser runtime

The operator uses Papr on the Mac. The engine API, worker, account-specific headed
Chromium processes and interactive login desktop run in one long-lived Daytona
sandbox. Accounts sign in inside that sandbox; no Mac Chrome cookies are copied.

## Storage and process ownership

`/data/outreach` holds SQLite WAL, private runtime configuration, the engine token,
and consistent local database backups. `/data/chrome-profiles/<account-sha256>`
holds each account's persistent browser profile. Both use the persistent **sandbox
filesystem**, which survives stop/start. Do not attach Daytona managed FUSE volumes
at either path; runtime startup rejects recognized network/FUSE filesystem types.
Deleting a sandbox is distinct from stopping it and requires an independent backup
and recovery policy.

A persistent launcher keeps the sandbox alive while waiting for controller-written
metadata containing the actual sandbox ID. It autostarts from saved metadata
after restart and survives concurrent bootstrap ownership races.

One supervisor owns the display, window manager, loopback VNC server, noVNC,
API, worker and account-specific CDP browsers. The API and worker attach to those
browsers through unique loopback ports, never by independently opening the same
profile directory. Browser bindings are watched every two seconds. Failed children
restart with bounded exponential backoff; repeated failures stop the runtime.
Readiness requires the authenticated API and active Chrome CDP endpoints. At most two Chrome processes are leased through the supervisor; other configured profiles are inactive on persistent disk, not failed. Login connections shared by company-page targets serialize effects and inbox reads.

## Prepare and build

Use Node 24, Python 3.10+ and the Daytona CLI. Install the pinned SDK separately:

```sh
python3 -m venv .venv-daytona
.venv-daytona/bin/pip install -r deploy/daytona/requirements.txt
npm ci
npm run build
npm run check
npm run test:runtime
npm run test:browser
```

`test:browser` selects the Chromium revision installed by the locked Playwright
package. Set `OUTREACH_TEST_CHROME` explicitly for an isolated installed-browser
compatibility run; never point it at a personal browser profile.

The Dockerfile pins Node 24.13.1 and installs the exact Chromium revision required
by the locked Playwright package. It builds the workspace inside the image. It does
not depend on stale host dist files or a mismatched Playwright base image.

Build an explicitly named Daytona snapshot from the reviewed source:

```sh
.venv-daytona/bin/python deploy/daytona/manage.py build --snapshot outreach-reviewed-SOURCE_HASH
```

The build defaults to2 CPU cores,4GB memory and10GB disk using the container
sandbox class. Override `--cpu`, `--memory` and `--disk` within the account quotas.
It never raises organization limits.

This uses the Daytona cloud builder through its CLI; a local Docker daemon is not
required. Source validation and cloud image boot are separate checks.

## Create or reconnect

Set `DAYTONA_API_KEY`, or `DAYTONA_JWT_TOKEN` together with
`DAYTONA_ORGANIZATION_ID`, in the trusted operator environment. Alternatively, append `--cli-auth` to explicitly
reuse the selected owner-only `daytona login` session; the CLI refreshes its own
authentication and the controller never prints the credential. Never put provider
or engine credentials in the public repository.

```sh
.venv-daytona/bin/python deploy/daytona/manage.py create \
  --snapshot outreach-reviewed-SOURCE_HASH --name outreach-runtime \
  --state /absolute/private/outreach-connection.json
.venv-daytona/bin/python deploy/daytona/manage.py reconnect \
  --state /absolute/private/outreach-connection.json
```

Creation disables public access, idle auto-stop/auto-pause and auto-delete.
Reconnect uses the recorded sandbox ID and never silently creates a replacement.
The ID is persisted before readiness so failed provisioning remains recoverable.
The controller bootstraps the workspace and an owner-only console token, then
returns only the sandbox ID, readiness and connection-file path. It never prints
engine or preview credentials.

Configure `OUTREACH_CONNECTION_FILE=/absolute/private/outreach-connection.json` in
the trusted Papr backend. The file is mode 0600 and contains separate `apiToken`
and `previewToken` credentials. The backend rereads it for each request, forwards
the preview credential in `x-daytona-preview-token`, and keeps both credentials
out of browser state.

```sh
.venv-daytona/bin/python deploy/daytona/manage.py refresh --state /absolute/private/outreach-connection.json
.venv-daytona/bin/python deploy/daytona/manage.py watch --state /absolute/private/outreach-connection.json --interval 300
.venv-daytona/bin/python deploy/daytona/manage.py status --state /absolute/private/outreach-connection.json
```

`watch` refreshes the signed live-view URL before expiry. Standard preview tokens
are refreshed after reconnect as well. The engine API token has its own expiry;
the supervisor rotates one nearing expiry while preserving its role ceiling. The controller never deletes a
sandbox, and the worker continues without a Mac controller because auto-stop is
disabled. Stop a runtime explicitly with Daytona when its campaigns are paused.

## Account login and browser tasks

Use Carl-Allen Settings > Accounts to start or resume an account-specific private
browser session. Connect opens the platform login, discovers the signed-in native
identity, and asks you to confirm it. Reconnect checks the original identity. The
legacy `manage.py login-link` command now directs you to this authenticated flow;
an unscoped shared desktop link does not authorize browser access.

The legacy explicit-identity registration accepts the canonical
`https://www.linkedin.com/in/<slug>` identity. The protected admin endpoint creates
an owner-only binding in `/data/outreach/social-bindings.json`, selects a unique
loopback CDP port and derives the profile directory from the account identity.
The supervisor launches the browser; then open live view, sign in and choose
Check/Reconnect. Identity changes require a new external account registration.

The provider verifies the signed-in identity before acting. New pages isolate API
health checks from worker actions. Logged-out/checkpoint/disconnected sessions hold
work for reconnect. An operation that may already have crossed its external-effect
boundary is uncertain and requires reconciliation/review rather than a blind retry.

Trusted browser recipes can be placed in the owner-only
`/data/outreach/browser-recipes.json` array. Each declares allowed origins, bounded
text parameters, fixed steps, one final external-effect click and a new native
receipt marker. Bind a separate `recipeIdentities` rule per account and recipe.
Engine approval hashes include the discovered recipe-definition hash as well as
its parameters. Changing a recipe requires restarting its API/worker configuration, refreshed discovery and fresh approval.
This supports configured signed-in browser workflows without accepting arbitrary
JavaScript, URLs or selectors from action requests. See the browser provider README
for its exact recipe schema. Unsupported sites are not advertised as native drivers.

For LinkedIn image posts, configure `OUTREACH_MEDIA_ALLOWED_ORIGINS` as a JSON array
of trusted HTTPS asset origins. Empty means attachments are disabled. The provider
bounds image count/bytes, validates image content and waits for an upload preview;
it never silently sends a text-only post when an attachment fails.

## Qualification

Run deterministic local tests plus real Chromium fixtures before building the
reviewed image. After deployment, run `status`, confirm the private API through
Papr, login, and exercise approved synthetic post/DM/invitation/draft cases.
Record actual platform receipt IDs, checkpoint/reconnect, restart persistence,
Mac-off scheduling, kill/caps and Gmail/Outlook regression independently.

The implementation does not represent fixture success as LinkedIn, mailbox or
Papr desktop acceptance. A provider account, human login and approved target/content
are required for those live checks. No live send happens during provisioning.

References: [persistence](https://www.daytona.io/docs/en/persistence/),
[preview authentication](https://www.daytona.io/docs/en/preview/),
[volume limitations](https://www.daytona.io/docs/en/volumes/),
[process execution](https://www.daytona.io/docs/en/python-sdk/sync/process/).

## Recipe-only signed-in browser accounts

A trusted operator may add a browser-only binding before registering it in Papr:
`kind: "browser"`, an account-specific loopback `cdpUrl`, and `recipeIdentities`
for already-configured recipes. Each identity rule supplies a trusted selector,
optional attribute and exact expected identity. This binding advertises browser
recipes only, with no LinkedIn publish/message/connect capabilities. Its health
check visits the approved recipe entry pages and verifies identity without
executing effect steps. The Papr account form can register an existing configured
browser account without a LinkedIn URL; it cannot create selectors or recipes.

## Read-only live receipt qualification

After the operator has created and approved the intended live cases in Papr,
copy `qualification-cases.example.json`, enter the exact action/account IDs, and
run:

```sh
python deploy/daytona/qualify.py --state /absolute/private/outreach-connection.json \
  --cases /absolute/private/approved-cases.json --output /absolute/private/live-receipts.json
```

The command reads authenticated action status and native receipts. It never
creates, approves or executes actions. It records Mac-off, restart, checkpoint
and actual Papr host acceptance as unverified until those tests have separate
observations. Known synthetic receipts cannot pass this check.


## Publishing media execution budget

Publishing with media attachments uses a180-second provider budget by default.
Text-only publishing, messages and mailbox calls retain the existing30-second
budget. Set `OUTREACH_PUBLISHING_MEDIA_TIMEOUT_MS` between1 and300000 milliseconds
for the Daytona configuration, or set `execution.publishingMediaTimeoutMs` in a
trusted `outreach.config.mjs`. The CLI forwards that configuration to the engine.
The default execution lease is ten minutes; an explicitly shorter media lease is
raised to the media budget plus five seconds. An expired executing lease becomes
uncertain, never an automatic resend. A timeout after a possible effect keeps its
budget reservation and requires reconciliation or human review.

## Cloud gateway bootstrap environment

Provision `CLOUD_GATEWAY_SECRET`, `CLOUD_MEDIA_SECRET`, `CARL_PUBLIC_ORIGIN`, and `OUTREACH_MEDIA_GATEWAY` through the trusted operator process. Bootstrap persists only explicitly allowed cloud names and OUTREACH_* settings in the owner-only `/data/outreach/runtime.env.json`; supervisor validates these names before loading them. Secrets remain outside source, HTML, screenshots and connection responses. The Worker and runtime share scoped gateway/media secrets; the user identity must still be authenticated and resolved to engine roles. Restart the supervised services after changing the private runtime environment. This does not create a second scheduler or require the Mac to remain online.

Outlook automated outreach is an explicit deployment choice. The shipped runtime enables
`outlookAdapter({ purposes: ['manual_correspondence'] })`. After the mailbox owner and
tenant administrator permit the intended use, add `automated_outreach` to that adapter's
`purposes` in `outreach.config.mjs` and register the selected account with the same purpose.
Account identity, permitted purpose, suppression, live-recipient gate, daily policy and
human plan approval remain required. Zoho exposes only inbox and drafts; it has no send port.
