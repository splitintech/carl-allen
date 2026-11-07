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

Generate independent random values of at least32 characters for the three shared/session secrets. The existing private sandbox must have auto-stop disabled for unattended schedules. The Worker refreshes its standard private API preview credential on each request. Admin-only `/browser-login` separately mints a15-minute signed URL for port6080; a standard sandbox-wide preview token never enters the UI. Other team roles cannot open the shared browser desktop.

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
3. Configure mailbox OAuth grants through the trusted CLI with `outreach account connect gmail`, `outreach account connect outlook` or `outreach account connect zoho --help`; keep grant files private and register the mailbox with the required purpose. The mailbox UI manages connected inboxes/drafts. Zoho has no sending port and uses **Open in Zoho** for manual sending. Its regional OAuth API choice must match the account.
4. In **Create**, download the HTML template, prepare research/content in Papr or ChatGPT, and upload the HTML with accompanying images/MP4 videos. Arbitrary reports open guided Contacts, Publications and Outreach steps mapping. Preview source values and mapped records before saving; missing recipients and ambiguous dates block mapping. Duplicate filenames require an explicit resolution.
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

Before runtime upgrade, retain the old immutable source, the local SQLite snapshot, the private runtime settings and any quiesced profile archive. Install/build the new source in another directory, test it, stop the supervised services, switch source, and bootstrap once. Migrations0008–0012 preserve historical source checksums and rebuild/validate references. Rollback after a migration requires the matching pre-upgrade database and source; do not run older code over a new schema.

The acceptance ledger in `docs/plans/carl-allen-requirements.json` separates source tests from Google/Cloudflare deployment, real mailbox/social receipts, Papr/ChatGPT acceptance and a Mac-off operational soak. Perform the staged pilot with specifically approved accounts, recipients and content before wider use.
