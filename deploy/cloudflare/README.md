# Carl-Allen cloud deployment

The user deploys this Worker. Source verification does not deploy the service, create a Google OAuth client, bind a domain, connect accounts, or qualify live sends. Daytona remains the only execution scheduler. No Auth0 tenant or OpenAI API key is required.

## Build and check

Use Node24 for the gateway and the locked dependencies:

```sh
npm ci
npm run build
npm run studio:build
npm --prefix deploy/cloudflare ci
npm run test:cloud
npm --prefix deploy/cloudflare run check
```

`dist/publishing-studio.html` is the single interface artifact. Its JavaScript and CSS are inline; no external executable assets are needed. It still requires the authenticated gateway and engine. Serve it through the Worker or use `npm run studio` for the trusted local preview; opening a file directly does not start an engine or container.

## Uploaded files and background jobs

In **Create**, import an HTML file. Carl Allen parses its triggers and opens the stored original inside the app. Inspect a highlighted control or a detected trigger, explicitly include the supported triggers you want, choose a time and time zone, then select **Schedule background job**. The file must finish opening before scheduling becomes available. **Save job draft** retains a selection without starting it.

At the chosen time the Daytona worker opens the source in an ephemeral browser, opens selected public HTTP(S) pages, and retains selected email drafts in the job's **Run results**. The job continues after the app window closes. Opening an email trigger prepares its recipients, subject, and body inside Carl Allen; it does not send an email. Saved jobs expose server status, pause, reschedule, and cancellation controls. A cancelled or paused run cannot be revived by a late browser result.

Literal links, mailto fields, static redirects, and supported simple helper functions are detected from the original source. Original scripts, external resources, form submission, and unsupported dynamic behavior remain inactive in the document view. Unsupported triggers are listed explicitly. File controls inspect behavior; they do not schedule or activate it by themselves. The separate **Execution plan** handles reviewed publishing and provider outreach, including its account, date, media, and approval requirements. A document job does not release provider outreach pauses or create sending approvals.

The Daytona config enables document jobs by default. Set `OUTREACH_DOCUMENT_JOBS=0` to disable execution or `OUTREACH_DOCUMENT_CHROME_EXECUTABLE` to select the installed Chrome binary. The API and worker need migration `0016_document_jobs` and the same built source. Jobs that cannot access a runner or finish safely retain a **Needs attention** result rather than being reported as completed.

## Google and team access

1. In Google Cloud create an OAuth **Web application** client with `openid email profile` consent. Register the exact redirect URI `https://carl-allen.splitin.net/auth/callback`. Set the JavaScript origin to `https://carl-allen.splitin.net`. Add designated test users while the Google application is in testing.
2. Store the Google client ID in Wrangler vars and the client secret through Wrangler secrets. Carl-Allen uses authorization code, PKCE, state, nonce and verified Google email. The host-only encrypted session cookie is HttpOnly/Secure; mutations require the session CSRF token and same origin. If a flow expires or returns in another browser, restart `/auth/login` in the original browser.
3. Before first Google sign-in, invite the first administrator through the existing trusted engine owner session using `POST /v1/team/invitations` with `{"email":"your-approved-email@example.com","roles":["admin"]}`. Do not invent a principal or make every Google login an owner. Invitations expire after7 days and claim only a verified matching Google email. Later invitations are available in **Settings → Members**.
4. Roles are resolved in Daytona on every delegated request. Removing a principal's role immediately affects existing sessions/MCP grants. Use the trusted owner CLI/API for emergency role recovery. Google authentication alone does not grant membership.

## Cloudflare resources and configuration

Create a private R2 bucket and a KV namespace in your account:

```sh
cd deploy/cloudflare
npx wrangler r2 bucket create carl-allen-private-media
npx wrangler kv namespace create OAUTH_KV
```

Put the returned namespace ID in `wrangler.jsonc`; retain `OAUTH_KV` and `MEDIA` binding names. Set `WORKSPACE_ID` to the existing Daytona workspace, not a new arbitrary value. Review the custom-domain route before deployment. Keep the R2 bucket private; do not enable `r2.dev` or a public bucket domain.

Configure Worker secrets without putting their values into source or chat:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CLOUD_GATEWAY_SECRET
npx wrangler secret put CLOUD_MEDIA_SECRET
npx wrangler secret put DAYTONA_API_KEY
npx wrangler secret put DAYTONA_SANDBOX_ID
```

Generate independent random values of at least32 characters for the three shared/session secrets. The existing private sandbox must have auto-stop disabled for unattended schedules. The Worker refreshes its standard private API preview credential on each request. Admin-only `/browser-login?session=<id>` checks ownership, activates that account and mints a15-minute signed URL for port6080. Its WebSocket additionally requires a revocable token for the active human-login reservation. Ending/expiring the reservation disconnects viewers before another profile runs; possession of an old signed asset URL is insufficient. A standard sandbox-wide preview token never enters the UI.

The runtime must receive matching `CLOUD_GATEWAY_SECRET` and `CLOUD_MEDIA_SECRET`, plus `OUTREACH_MEDIA_GATEWAY=https://carl-allen.splitin.net` and `CARL_PUBLIC_ORIGIN=https://carl-allen.splitin.net`, through its trusted private bootstrap environment. Run the reviewed `deploy/daytona/bootstrap.mjs` after installing the new source. It preserves the runtime settings in owner-only state. Never expose port9222/CDP publicly. Local stdio MCP and the old trusted Papr bridge remain available.

For a deliberate fixed private API URL, `DAYTONA_API_URL` and `DAYTONA_PREVIEW_TOKEN` can replace the API-key pair, but they require independent rotation and do not provide cloud browser-login minting. Prefer the API-key configuration for this release.

Run `node scripts/cloud-preflight.mjs` from the repository root with the corresponding environment configured locally. It reports presence and minimum secret lengths without printing credentials. This checks local configuration, not the values already installed in Cloudflare.

Deploy only after the placeholders are replaced:

```sh
npm --prefix deploy/cloudflare run deploy
```

Google/Cloudflare secret values and the first invitation are external configuration. This repository does not supply them.

## Connect accounts and hand off a month

1. Sign in with the invited Google account; open **Settings → Accounts**. Add LinkedIn, X, Instagram or TikTok profiles. Several accounts on the same platform are supported. A LinkedIn page selects an existing personal administrator connection. Browser profiles persist in the existing Daytona sandbox; launching the UI does not create another sandbox. At most two browsers are active at once.
2. As an administrator open the private browser, sign in to the selected platform, then click **Check connection**. A login challenge or wrong identity holds execution. Credentials/cookies are never included in HTML packages.
3. Connect Gmail, Outlook or Zoho in **Settings → Accounts** using provider consent and verified mailbox selection. A provider whose server client is not configured remains visibly unavailable. Choose the correct Zoho data center. Gmail/Outlook reviewed outreach requires an explicit administrator attestation and a runtime adapter that permits that purpose; default connection is manual correspondence. The trusted CLI remains compatible. Zoho has no sending port and uses its regional **Open in Zoho** link for manual sending.
4. In **Create**, download the HTML template, prepare research/content in Papr or ChatGPT, and upload the HTML with accompanying images/MP4 videos. The original file opens in the document workspace described above. For provider publishing or outreach, open **Execution plan** to map Contacts, Publications and Outreach steps. Preview source values and mapped records before saving; missing recipients and ambiguous dates block mapping. Duplicate filenames require an explicit resolution.
5. Map logical account references to connected targets, repair dates/recipients/media, inspect rendered text and hashes, and submit. Sourced LinkedIn/Instagram contacts require canonical personal profile URLs with `www`, lowercase handles and no tracking parameters so recipient checks and replies match reliably. An approver reviews the exact plan in Carl-Allen. Pending decisions expire after72 hours; approval covers its displayed execution window, allowing day20/day31 execution. Publication schedules may be up to90 days ahead. Daily caps remain enforced and forecast conflicts block preparation. Administrators can set daily budgets in Settings → Connections & policy; changed budgets apply only to newly prepared plans.
6. Open **Inbox → Reply playbooks** to review each response rule separately. Approving the publishing/outreach plan does not authorize automatic replies. Inspect the condition, exact response, account, expiry and per-contact limits, then approve or reject with a reason. Revocation or package changes stop pending replies; uncertain effects retain their delivery state.
7. Wait for a durable cloud receipt. Only verified original/media storage plus approved scheduling produces it. A local/sandbox-only upload is not a cloud receipt. Daytona continues after the browser, Papr, ChatGPT and Mac close. Verify individual native receipts in the queue/inbox; login holds or uncertain results require review. Slots missed by over1 hour are not released as a catch-up burst.

Workspace media quota defaults to50GiB and is configurable in **Settings → Storage**. Image/video per-file limits are separate. Upload chunks are resumable; reservations expire after24 hours. R2-ready local cache is bounded to512MiB; browser execution stages isolated temporary files and checks immutable hashes. Local-only legacy assets are retained and checked. Work that references an asset protects it from deletion.

## Papr and ChatGPT MCP

Connect the remote server URL `https://carl-allen.splitin.net/mcp` in each host that supports authenticated remote MCP. Carl-Allen advertises resource/authorization discovery, dynamic registration/client metadata, PKCE, scoped expiring tokens and refresh. Google is used upstream for identity; raw Google ID tokens are not MCP bearer tokens. Consent shows `carl:read`, optional `carl:prepare` and `carl:control`. MCP cannot approve plans or elevate to approver/admin.

The tools retrieve the template/accounts, prepare handoffs, return review links, read results and perform permitted pauses. The browser upload is the guaranteed file path: a ChatGPT attachment is not automatically visible to an MCP server. Papr uses its existing remote-MCP connection/grant UI; do not run a second scheduler in Papr. Personal ChatGPT, team ChatGPT and Papr must each be accepted against the deployed URL; a protocol fixture is not that acceptance.

## Backups, rollback and qualification

The runtime already takes consistent local SQLite snapshots. For an explicit encrypted export, set a separate32-byte base64 `OUTREACH_RECOVERY_KEY` in a secure terminal and retain it independently:

```sh
node scripts/cloud-recovery.mjs export --database /data/outreach/outreach.db --output /data/outreach/recovery/NEW_EXPORT --workspace YOUR_WORKSPACE --cloud yes
node scripts/cloud-recovery.mjs restore --bundle /private/recovery/EXPORTED_BUNDLE --output /private/recovery/NEW_RESTORE
```

Use the actual configured database path. The export freezes the database and its media metadata together, verifies SQLite integrity/references, encrypts authenticated16MiB chunks and uploads only encrypted artifacts. Preserve `recovery.json` and the encryption key outside the sandbox. `cloud-receipt.json` identifies a separately encrypted R2 index; it is not a key. Download the encrypted objects into a private bundle before restore. Failed or altered chunks/manifests never overwrite an active database. Review integrity, grants, media references and kill switches before manually activating a restored copy.

Browser-profile recovery is separate: quiesce all browsers through the operator process, archive the private profile directory outside the source tree, then pass `--profile-archive /private/quiesced-profiles.tar.gz` to the export command. Do not archive actively written Chrome databases. No profile recovery is claimed when that option is omitted. Schedule encrypted exports through the trusted cloud operator after configuring the key; this tool does not create another social dispatcher.

Before runtime upgrade, retain the old immutable source, the local SQLite snapshot, the private runtime settings and any quiesced profile archive. Install/build the new source in another directory, test it, stop the supervised services, switch source, and bootstrap once. Forward migrations0013–0015 add social login sessions, mailbox OAuth/upload sessions and independent account lifecycle state. Verify `ffprobe` is installed (fresh images install `ffmpeg`) and `websockify` supports its token plugin. Rollback after a migration requires the matching pre-upgrade database and source; do not run older code over a new schema.

The acceptance ledger in `docs/plans/carl-allen-requirements.json` separates source tests from Google/Cloudflare deployment, real mailbox/social receipts, Papr/ChatGPT acceptance and a Mac-off operational soak. Perform the staged pilot with specifically approved accounts, recipients and content before wider use.

## Mailbox client configuration

Configure these on the private Daytona runtime, not in uploaded HTML, browser storage, or chat:

- `OUTREACH_GMAIL_CLIENT_ID` / `OUTREACH_GMAIL_CLIENT_SECRET`
- `OUTREACH_OUTLOOK_CLIENT_ID` / `OUTREACH_OUTLOOK_CLIENT_SECRET`; `OUTREACH_OUTLOOK_TENANT` defaults to `organizations`.
- `OUTREACH_ZOHO_CLIENT_ID` / `OUTREACH_ZOHO_CLIENT_SECRET`
- `OUTREACH_MAILBOX_DIR` for owner-only grant/upload files (directory0700, files0600).
- `CARL_PUBLIC_ORIGIN=https://carl-allen.splitin.net`
- `OUTREACH_MAILBOX_CALLBACK_ORIGINS='["http://127.0.0.1:8790","http://localhost:8790"]'` only when trusted local callback support is wanted. The configured public origin is always permitted; arbitrary browser-supplied redirect origins are refused.

Register each provider’s exact callback URI `/auth/mailbox/gmail/callback`, `/auth/mailbox/outlook/callback` or `/auth/mailbox/zoho/callback` at every intended origin. Google mailbox consent is separate from Google workspace sign-in and requests mailbox scopes. OAuth state is expiring, single-use and bound to the initiating workspace/user; grants and PKCE verifiers never enter the frontend. Multiple authorized Zoho mailbox identities are shown for explicit selection. Microsoft disconnect removes the local grant and stops work, then directs the administrator to provider consent management; it does not claim an app-specific server revocation that Microsoft did not acknowledge.

## Connection, qualification and recovery UX

Select **Connect** → **Start private sign-in** → **Open private browser**. Only the selected profile is visible while a human reservation is active; automated browser operations wait. Sign in on the platform’s own page and complete challenges there. Carl-Allen detects the native identity, keeps renewing while you review it, and asks for confirmation. **Finish later** releases the reservation and retains a resumable private profile. Confirmed identities can be reconnected without reusing local Chrome cookies. Company pages bind to a verified personal administrator connection.

**Verify publishing formats** observes the native account type, composer and publishing identity. Unknown capabilities stay blocked. In the composer, **Verify selected format and media** can stage the selected immutable assets in the native composer, which is necessary when reel controls appear only after upload. It never submits a post. Execution rechecks identity/native controls and preserves uncertain effects for review. Video preflight requires supported codecs, dimensions and duration; it does not silently transcode approved assets.

For automatic local desktop-link renewal configure `OUTREACH_DAYTONA_API_KEY` on the trusted bridge (using the saved connection’s sandbox ID), or repository-local `OUTREACH_DAYTONA_REFRESH_PYTHON` pointing to a Python interpreter with the Daytona SDK. Set `OUTREACH_DAYTONA_CLI_AUTH=1` only to explicitly reuse the selected local Daytona CLI login. The optional Python path is for the repository preview; Papr installations can use the server-side API-key configuration. No credentials enter the HTML artifact.

Disconnect stops affected plans/sequences and revokes authorizations without treating uncertain/in-flight effects as unsent. Browser profiles are retained by default; deletion additionally requires no shared target, active reservation or unresolved effect. Reconnection never restores revoked plans automatically.

One-to-one inbox readers persist paging/backfill and include discovered Instagram request folders. Unknown layouts, incomplete history or unsupported group conversations hold automated follow-ups instead of claiming full coverage. Group support requires manual handling; the UI displays the hold. Manual social responses are prepared from the exact native thread and require their own review/approval. Zoho supports ordinary attachment and CC/BCC editing; inline-CID edits remain held to avoid breaking embedded images. Use native Zoho for those drafts and all sending.

Provider references: [Zoho draft API](https://www.zoho.com/mail/help/api/save-draft-template.html), [attachment upload](https://www.zoho.com/mail/help/api/post-upload-attachments.html), [Zoho token revocation](https://www.zoho.com/developer/oauth/revoke-oauth-token.html), [Microsoft authorization code and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), and [websockify token plugins](https://github.com/novnc/websockify/blob/master/README.md).
