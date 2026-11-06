---
name: Buffer Daytona Outreach - comprehensive completion
overview: Complete the audited engine, signed-in browser, calendar, mailbox drafts, Papr and durable Daytona runtime; qualify source, actual browser fixtures, cloud runtime and live accounts separately.
todos:
  - id: engine-correctness
    content: Historical database upgrades, strict capabilities, suppressions, account routing, approvals, kill switches, windows and caps
    status: completed
  - id: social-provider
    content: Verified LinkedIn identity, confirmed posts/DMs/invitations, image attachments, resumable authentication and uncertain effects
    status: completed
  - id: browser-recipes
    content: Origin-restricted browser recipes with account identity, exact definition hash, bounded parameters and approved effect boundary
    status: completed
  - id: mailbox-drafts
    content: Gmail and Outlook mailbox draft CRUD through protected API, CLI and Papr without hidden sending
    status: completed
  - id: content-authoring
    content: Create/edit/delete content drafts, schedule/edit/cancel queued actions, fresh approvals and explicit manual fallback
    status: completed
  - id: daytona-runtime
    content: Implement Node24 matching-browser image definition, sandbox-local disk, CDP supervisor, create/reconnect and preview refresh
    status: completed
  - id: papr-remote
    content: Private preview credentials, connection-file renewal, account bind/login/check, content and mailbox controls with host manifests
    status: completed
  - id: local-qualification
    content: Regression/worker/API/proxy tests, build/type/lint/boundary checks and actual Chromium fixtures
    status: completed
  - id: cloud-qualification
    content: Reviewed image/private API/worker/profile restart, renewal and detached scheduling verified; literal powered-off-Mac acceptance remains
    status: in_progress
  - id: provider-host-acceptance
    content: Human Daytona account login, approved live post/DM/invitation/draft receipts and actual Papr desktop acceptance
    status: pending
isProject: false
---

# Buffer-style outreach on Papr and Daytona

This revision replaces the earlier completed checkboxes with acceptance gates.
The original six delivery areas remain required. Implementation expands to close
all concrete audit findings, including connection invitations, mailbox drafts and
constrained general browser recipes. A file existing, a fake success, local tests,
cloud deployment and human/provider acceptance are separate facts.

## Product and placement

One engine owns content calendar campaigns and contact outreach sequences. Papr
is the desktop operator console. One persistent Daytona sandbox owns the API,
worker, interactive desktop, account-specific Chromium browsers and SQLite.
The Mac is not the social executor. Accounts sign in inside Daytona; Mac/Papr
Chrome cookies are not transferred. X/Instagram are not advertised as native
LinkedIn drivers; additional websites use explicitly configured trusted recipes
or separately implemented and qualified drivers.

Use persistent sandbox-local filesystem paths for active SQLite WAL and Chrome
profiles. Do not mount Daytona managed FUSE/object-backed volumes at these paths.
Consistent SQLite backups are separate from the live database. Stop/start retains
the sandbox identity/disk; deletion requires an independent recovery decision.

## Engine correctness requirements

1. Preserve already-applied migration SQL digests. Upgrade databases containing
   historical attempts, manual tasks, approvals and actions without FK failures
   or data loss; restore FK enforcement and run foreign-key/integrity checks.
2. Require explicit matching capability flags, account purposes and Daytona
   execution placement at compile and execution time. Missing capabilities mean
   unsupported. Account discovery must not falsely attest a Mac executor.
3. Bind each email/social/browser sequence step to its selected provider account,
   retaining campaign binding as the compatibility default. Hash those bindings
   into preparation and approval. Support social-profile audiences without an
   unrelated mandatory email address.
4. Recheck current contact/global/channel suppressions before each social touch.
   Keep leases, at-most-once attempts, review and uncertainty handling intact.
5. Preserve content policy semantics: first-batch/campaign approvals, action
   approvals, quiet hours, expiry, daily account/channel/campaign caps and kill
   switches. Standalone browser actions require explicit approval and budgets.
6. Allow safe content draft CRUD, editing and cancellation. Refuse in-flight or
   uncertain action mutation. Every changed content/media/recipe input receives
   a new content hash and fresh approval; unaffected shared approvals survive.
7. Provide explicit operator conversion to a manual task when opting out or
   reconnecting. Never silently send through another channel.

## Browser provider requirements

- Separate social.publish, social.message and social.connect capabilities.
  Invitations/connection notes must use a real Connect flow, not a renamed DM.
- One supervised CDP browser and durable profile per external account. The API
  and worker attach to those browsers, with independent operation pages. Match
  the actual signed-in LinkedIn profile to the immutable account identity.
- Detect logged-out/checkpoint/disconnected states. Before the external effect,
  hold for resumable authentication. After an effect may have occurred, record
  uncertainty and prevent blind retries. Honour cancellation during startup,
  navigation, editing, clicking and confirmation.
- Record success only with a newly observed native platform receipt associated
  with the requested operation. A click, delay or locally generated action ID
  is not a success receipt. Pre-existing identical content is not confirmation.
- Support approved image attachments with trusted HTTPS origins, bounded counts
  and byte sizes, content-type/magic validation and upload preview confirmation.
  Attachment failure must never silently publish text only.
- Trusted browser recipes contain fixed URLs/selectors, allowlisted origins,
  bounded text inputs, account identity rules, one explicit final effect boundary
  and a new native confirmation marker. Requests cannot supply arbitrary code.
  Freeze the recipe definition hash in the approved action and reject changes.

## Mailbox drafts

Keep existing Gmail/Outlook send/reply adapters. Add separate list/get/save/delete
mailbox-draft ports and protected CLI/API/Papr operations. Draft mutations must
not send mail, and sender identity must match the connected account. Outlook
updates/deletes must first prove the selected message is a draft. API mailbox
credentials remain separate from Chrome login. Browser mailbox workflows may be
implemented as explicitly approved trusted recipes, with their own signed-in
identity and confirmation requirements.

## Daytona runtime

Build a Node24 image that installs Chromium from the same locked Playwright
version. Set up headed display, window manager and private live view. One
supervisor owns the API, worker, desktop and per-account CDP browsers; provide
readiness, bounded restarts, singleton/PID ownership and orderly shutdown.

Provide executable build/create/reconnect/status/refresh/watch/login tools.
Persist sandbox identity before readiness so failures cannot create orphan
replacements. Reconnect must use that identity. Disable auto-delete and prevent
idle stopping while unattended campaigns run. Preserve local disk state and
provide consistent backups. No live post/message occurs during provisioning.

Keep engine and Daytona preview credentials separate. Write connection material
only to owner-only files. Refresh preview credentials after reconnect and signed
live-view links before expiry. Rotate expiring engine tokens without disrupting
long-lived operation. Preserve signed URL query/path data and reject redirects
that could expose credentials.

## Papr operator console

Retain the existing console design and fixed backend action allowlist. Add
content composition, draft editing, scheduling, cancellation, account binding,
health/reconnect, invitations, trusted browser tasks and mailbox-draft controls.
Keep exact approval hashes, roles, review, manual tasks and kill controls working.
The backend reloads private connection credentials per request. Supply correct
per-action/server-only key manifests. No token is exposed to browser state.
Real Papr import/key provisioning and host acceptance require explicit evidence;
the historical closed/unmerged PR is not proof of installation.

## Verification and delivery gates

A. Local source: regression tests prove every former defect is fixed; historical
migration replay, real-worker mixed-channel/cap/suppression/approval/reauth tests,
API/CLI/role/proxy/draft checks, build/type/lint/boundaries/secrets/line limits.

B. Actual browser fixtures: real Chromium exercises login identity, posting,
messages, invitations, attachments, no-op/ambiguous receipt cases, cancellation,
CDP reconnect, origin restrictions and console authoring. Page doubles do not
satisfy this gate. Tests use isolated profiles and local synthetic sites only.

C. Cloud runtime: boot the reviewed immutable snapshot, confirm authenticated
private API/worker/Chrome readiness, restart persistence, Mac-off scheduling,
private-preview refresh, token rotation and failure recovery.

D. Provider and host: operator signs into intended Daytona accounts; approved
live test post, DM, invitation and mailbox draft produce actual native IDs.
Exercise checkpoint/reconnect, caps/kill and actual Papr host import/permissions.
Only approved account/target/content is used. This gate cannot pass from fakes.

Record exact source hashes, image/sandbox IDs, commands, redacted receipts and
remaining external prerequisites. Do not mark C or D complete from A or B.
Keep private account configuration and company context outside the public engine.


## Verified implementation and cloud runtime

Source gates A/B are implemented. Final integrated run covered383 tests across52
files, including18 provider Chromium fixtures and two console Chromium workflows.
One existing100k-row import timing benchmark exceeded its10s budget by0.18s under
parallel load; its isolated rerun passed all12 importer tests. Eight Node runtime and
17 local Python lifecycle/qualification tests cover resource flags and TLS trust
fallback in addition to persistence/credential rules. Earlier10,000-action local
soak and1000-action cloud soak had exactly one attempt per fake action.

The user approved the exact source archive with source hash
`cde8d5921a93dcb9368c3eab119e65d71c12620abe41620a4d1087781ecf014f`.
Snapshot `outreach-runtime-cde8d5921a93`, ID
`8bbee572-d68c-4954-987b-27d2a3e5321d`, built and is ACTIVE.
Dedicated private sandbox `1cfb0ef9-bf7f-42c7-9a03-c02f6c270f82` runs
Node24.13.1 and its exact locked Chromium158.0.8127.18 on Linux x64.
Private API, worker and headed profile broker are ready. Actual cloud browser
suite34/34, runtime20/20 and MCP subprocess check passed. Separate preview and
engine credentials are required; wrong/missing credentials fail. No tokens are
included in this plan or the import bundle.

Same-ID stop/start preserved SQLite integrity, completed synthetic action and a
supervised Chrome profile cookie. Closing only the synthetic browser demonstrated
automatic supervisor recovery with the cookie intact. The existing monitor
renewed a credential after a simulated near-expiry metadata trigger, preserving
its role and authenticated API access. Private preview connection refreshed
after restart. A detached cloud worker executed one action90s after scheduling,
with the local SDK request already disconnected. The Mac was not physically
powered off; that literal acceptance drill remains unperformed.

Local source is newer than the exact-approved image: positive resource flags/
10GB quota default, TLS trust fallback, image test-config copy, CLI fake-social
secret/binding corrections, and the expanded Accounts UI. Modified source was
not uploaded under the original payload-specific approval. The UI runs in the
local Papr bundle against the existing remote APIs. Record these source/image
boundaries when deploying a newer snapshot.

## Connect accounts later

At the user's request, real account setup is deferred to an Accounts & connections
UI. It offers LinkedIn and administrator-configured browser profiles, guided
account details -> private browser sign-in -> session identity check, recoverable
errors and finish-later behavior. No password/cookie/token inputs are provided.
Mobile layout and the complete connection workflow were tested in real Chromium.
Gmail/Outlook are OAuth mailbox APIs; their cards accurately explain administrator
OAuth setup rather than pretending browser login connects a mailbox. Other social
networks require a configured trusted recipe or separately implemented driver.

GateD remains pending by design: no real accounts were connected and no live
post, DM, invitation or email was sent. Actual native provider receipts and Papr
desktop import/full host validation need human/operator acceptance. The bundle
and local proxy tests do not satisfy that gate. Literal powered-off-Mac acceptance
also remains open; the remote process independence evidence is recorded above.
