# @splitin/outreach-provider-social-browser

A capability-gated, account-bound Playwright provider for LinkedIn, X, Instagram
and TikTok publishing, LinkedIn direct messages and connection invitations, plus
trusted configured browser recipes. No stealth or challenge bypass is included.

## Runtime and accounts

Production execution requires Linux and a matching `DAYTONA_SANDBOX_ID`. The
operator starts one supervised Chrome instance per account in the Daytona sandbox,
with persistent local profile storage and a unique loopback CDP port. API and worker
attach to that instance rather than independently opening the same profile directory.

```js
socialBrowserAdapter({
  runtime: { kind: 'daytona', sandboxId: process.env.DAYTONA_SANDBOX_ID },
  accountBindings: () => readPrivateBindings(),
  recipes: trustedRecipes,
  media: { allowedOrigins: ['https://approved-images.example.com'] },
});
```

New native bindings use the canonical lowercase profile URL as `externalAccountId`,
so host/slash/case variants reuse one profile and account budget. Historical arbitrary
keys are preserved when they already identify that same profile. Bindings contain:

```json
{
  "https://www.linkedin.com/in/operator/": {
    "kind": "linkedin",
    "expectedProfileUrl": "https://www.linkedin.com/in/operator",
    "cdpUrl": "http://127.0.0.1:9222"
  }
}
```

The signed-in platform identity must match `expectedProfileUrl` before execution.
An optional trusted `identitySelector` can be configured for the platform's identity
module. A missing marker fails closed. Multiple accounts cannot share a CDP endpoint.
Bindings can be resolved dynamically; changes invalidate the account's cached session.

Each operation uses its own page; operations for one account are serialized. Failed
pages are retained (at most one per process/account) for operator inspection/reconnect.
Production login uses the sandbox live view, with its own cookies. Mac cookies are
not imported. Call the adapter's `close()` at host shutdown to release connections.

## Results and limitations

Posts and messages need a **new native platform identifier** in the confirmed DOM.
Invitations need a successful platform response carrying a native invitation URN.
There are no fabricated success receipts. Errors before an effect yield a definite
rejection; expired/mismatched/disconnected sessions require reauthentication. Once
an effect may have happened, missing confirmation yields `unknown` for human
reconciliation. The provider does not claim external idempotency or automatic sent
search. Checkpoints require human reconnect; cancellation closes the active page.

## Publishing and uploaded media

Accounts bind one canonical profile and one channel (`kind`: `linkedin`, `x`,
`instagram`, or `tiktok`). Discovery advertises only that channel. Messaging and
connection invitations remain LinkedIn-only. The identity is checked before
composition and again before the final publication effect for the new drivers.
Each driver's fixed production origin and the bound account are enforced; request
payloads cannot choose a new origin or executable selector.

| Channel | Implemented conservative publishing limits |
| --- | --- |
| LinkedIn | 3000 caption characters; text, up to4 images or one video |
| X | 280 caption characters; text, up to4 images or one video |
| Instagram | 2200 caption characters; up to10 images or one video; media required |
| TikTok | 2200 caption characters; exactly one video; web photo publishing unsupported |

These are this implementation's bounds, not claims of maximum platform/premium
limits. Mixed image/video batches are rejected. Publishing requires MP4 video on all four
channels; stored WebM must be converted externally. Instagram requires JPEG/PNG
images, so WebP must also be converted before scheduling. Platform codec, resolution, duration,
account permissions and interface changes may impose further constraints.

Studio uploads use `outreach-media://<sha256>` references. The provider reads private
files from `OUTREACH_MEDIA_DIR` (or `$OUTREACH_HOME/media`, default `.outreach/media`),
in a `sha256(workspaceId).slice(0,24)` directory. It refuses traversal/symlinks,
non-private storage, invalid image/video signatures, changed hashes, images above
5MB and videos above100MB. Immutable file identity is carried in approved payloads.
Uploaded media stays on the runtime disk and does not require a public CDN URL.

Existing approved-origin HTTPS image URLs remain supported separately. Downloads
reject redirects/credentials, enforce bounded image size and matching signature/MIME.
Arbitrary remote video URLs are unsupported. Upload readiness must confirm all files
before publication; media is never silently dropped. Video upload/processing waits
allow up to120 seconds independently of the shorter15/30-second receipt checks.
Explicit fixture timeout overrides stay short; the engine cancellation signal and
its media-action deadline remain authoritative.

X/Instagram/TikTok native receipt responses must come from the final create request,
carry its exact approved caption, and contain a new platform publication identifier.
DOM fallback requires a new publication URL, matching caption and the bound author's
profile within the same post. Empty captions cannot use arbitrary feed links as
confirmation. An attempted effect without proof stays unknown for human review.

Current selectors are fail-closed implementations qualified only against local
Chromium fixtures. They must be qualified against the intended signed-in real
accounts before production acceptance. No real X, Instagram or TikTok publication
is claimed by the implementation or fixture tests. Official product references:
[LinkedIn posting](https://www.linkedin.com/help/linkedin/answer/a522602),
[X posting](https://help.x.com/en/using-x/how-to-post),
[X video](https://help.x.com/en/using-x/x-videos),
[TikTok web video scheduling](https://ads.tiktok.com/business/en-US/blog/introducing-video-scheduler-now-you-can-plan-tiktoks-in-advance).

## Trusted browser recipes

Task requests supply a configured recipe ID and bounded string parameters. They
cannot supply JavaScript, URLs, selectors or executable code. Trusted operator
configuration defines `BrowserRecipe`:

```js
{
  id: 'approved-recipe',
  allowedOrigins: ['https://example.com'],
  parameters: { text: { maxLength: 300 } },
  steps: [
    { type: 'goto', url: 'https://example.com/compose' },
    { type: 'fill', selector: '#message', parameter: 'text' },
    { type: 'click', selector: '#send', effect: true },
  ],
  confirmation: { selector: '[data-receipt]', attribute: 'data-receipt' },
}
```

Each binding also requires `recipeIdentities[recipeId]` containing a trusted identity
`selector`, optional `attribute` and exact `expected` value. Identity is verified on
the initial page before effects. Recipes require exactly one declared effect click,
HTTPS origins (loopback HTTP is test-only), bounded declared parameters, and a new
platform receipt. The exact trusted recipe hash is advertised per bound account and
must match the approved task snapshot. Changes require a new approval. Requests to
other origins are blocked. Include necessary resource
origins explicitly. Configure only reviewed flows where pre-boundary clicks are
known to be free of external effects.

## Verification

`OUTREACH_BROWSER_FIXTURES=1 npm exec vitest -- run packages/outreach-provider-social-browser/src --maxWorkers=1` runs real Chromium against a disposable local HTTP
fixture: native receipts, wrong sender, checkpoints, uncertain outcomes, connection
invitations, cancellation, disconnect handling, recipe validation and profile-cookie
persistence and image-upload confirmation. The browser suite is opt-in because it
requires a compatible browser, local listener/process permissions and a working display
backend; default unit validation does not imply browser acceptance. Set `OUTREACH_TEST_CHROME` to a compatible installed Chromium executable
when the default Playwright revision is unavailable. No test contacts LinkedIn or
sends external messages.

DM execution verifies the opened conversation header's canonical profile link against
the approved target before filling or sending. If the deployed LinkedIn layout needs
a different conversation-header selector, set the trusted account binding's
`messageRecipientSelector`; task input cannot replace it. Missing or mismatched
recipient markers stop the operation for review rather than selecting another chat.

Recipe-only accounts use a trusted binding `kind: "browser"` with `recipeIdentities`
and their own supervised CDP endpoint. They do not require `expectedProfileUrl` or a
LinkedIn login, advertise no LinkedIn publish/message/connect capabilities, and
expose only recipe IDs actually bound to that account. Their health check navigates
to the trusted recipe's initial URL and verifies the configured signed-in identity
without filling fields or clicking any recipe controls.

The local implementation qualification used cached headless Chromium revision 1248
through `OUTREACH_TEST_CHROME` with disposable profiles and localhost fixtures. The
Daytona image installs the browser matched to locked Playwright 1.65.0; passing the
local override does not establish that image's boot or provider acceptance. Those
require separate runtime and signed-in-account evidence. No real social post,
message or invitation is sent by this fixture suite.
