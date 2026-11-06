# Publishing Studio

One publishing workspace for LinkedIn, X, Instagram and TikTok, backed by the outreach engine and a private Daytona browser runtime. The publishing page is the Papr bundle's default entry. The original outreach, LinkedIn messaging/connection and mailbox tools remain linked.

## Publish a post

1. Open Accounts, choose a platform and enter your own canonical profile URL, name and email. Create the connection, open the private browser login, sign in there and check the session. No Mac browser cookies are imported. Multiple spelling variants of the same canonical identity reuse the same account/profile.
2. Select Create a post and choose one or more platforms. Write the caption once and optionally copy it to the selected platforms; each platform's tab has an independent caption, account and attachment list.
3. Drag files into the composer or choose them from your computer. Wait for upload completion before saving/scheduling. Uploads have progress, cancellation and retry. Previously uploaded files are available in Media library, and attachments can be reordered or removed. Uploading a file does not publish it.
4. Preview each platform. These are layout previews; native platform crops and processing can differ. Video previews have playback controls. Use JPEG/PNG for Instagram; WebP can be used where the driver supports it.
5. Choose the date, time and time zone. Save a draft to return later, or choose Review & schedule. Review all captions, accounts, files and times, then submit for approval. Missing connection/capability or unsupported media leaves a saved blocked draft; it never silently schedules only part of a multi-platform plan.
6. In Publishing queue choose Review & approve and approve the exact post. The worker executes approved actions when due. Each platform has its own approval and delivery state. A scheduled action is not proof of successful publication. New native receipts are required before Published is shown.
7. Edit pending plans before execution; the engine cancels old actions and revokes their approvals, then new content needs fresh approval. Completed/in-flight/uncertain publications are not editable as if they were drafts. Duplicate a completed plan to start a new draft. Cancellation cannot recall an already attempted effect.
8. Stop all sending engages the workspace hold. Its state stays visible after refresh. Resume requires the appropriate role and cannot clear a separate global/account hold. If connection status cannot be refreshed, previously approved schedules may still continue in Daytona.

## Supported publishing combinations in this implementation

| Platform | Text | Images | Video |
| --- | --- | --- | --- |
| LinkedIn | Up to3000 composer characters | Up to4 images | One MP4 |
| X | Up to280 composer characters | Up to4 images | One MP4 |
| Instagram | Caption up to2200 composer characters; requires media | Up to10 JPEG/PNG images | One MP4 |
| TikTok | Caption up to2200 composer characters; requires video | Photo posts not supported by this driver | One MP4 |

These are conservative studio/driver limits, not every native platform feature. Do not mix a video and images in the same post. Library upload limits are5MB per image,100MB per video and500MB per workspace, with at most1000 assets and10 unfinished uploads. Composer uploads accept JPEG, PNG, WebP and MP4. The backend can retain WebM in the library, but publishing it is blocked with conversion guidance. This release does not transcode files, add music, crop or trim video. Container/signature checks do not prove codec, duration or platform acceptance; reduce/convert a file if the platform rejects processing. No stories, livestreams, polls, threads or X/Instagram/TikTok direct messaging are implemented here. LinkedIn messaging/connection requests remain in the original Outreach console.

The media worker has a180-second default effect budget (bounded configurable maximum300seconds), separate from ordinary30-second text/email actions. Video upload/processing waits default to120seconds. A timeout after a possible effect stays uncertain for review; it never blindly reposts. The default publishing policy uses a10-post account/channel daily cap and an all-day window in the chosen time zone; the engine still enforces approvals, holds, caps and expiry.

## Single HTML and trusted backend

Build with Node24:

```sh
npm run build
npm run studio:build
```

`dist/publishing-studio.html` embeds all publishing JavaScript and CSS. It contains no engine, social or preview credentials and has no external executable/style dependencies. Opened as a local file it is an explicitly offline interface preview. Durable saves, uploads and scheduling use the trusted backend; a self-contained UI file does not replace the remote worker.

To use that single HTML as the served interface, configure a private connection to an engine running this source revision, then run:

```sh
OUTREACH_CONNECTION_FILE=/absolute/private/daytona-connection.json \
OUTREACH_STUDIO_SINGLE_FILE=1 npm run studio
```

Open `http://127.0.0.1:8790/`; `/standalone.html` also serves the bundled file. The loopback server injects credentials only into the fixed backend requests, enforces host/origin/JSON/body boundaries, never serves backend source, and authorizes inline code with an exact content-security-policy hash. `npm run studio` without the single-file flag serves the maintained modular page. Papr imports the normal `apps/papr/bundle/` package with `publishing.html` as entry; preserve its actual assigned app ID. Full native Papr import/validation remains a separate acceptance gate.

The trusted backend must connect to an engine revision containing these publishing/media endpoints. Importing UI files alone does not create server endpoints or update a cloud runtime. Verify actual deployed source and private API readiness separately from a local build; signed-in account acceptance remains separate.

## Storage and operating boundaries

The engine owns workspace-scoped draft/upload/media metadata in SQLite. Raw immutable files live under `OUTREACH_MEDIA_DIR` or `OUTREACH_HOME/media`, in private workspace directories. In Daytona that is sandbox-local disk under `/data/outreach`. Uploads use64KB chunks and SHA256 references; the executor rechecks approved bytes before attaching them. Referenced media cannot be deleted through the library. Preserve the media directory along with the database/profile state for backup/recovery; a SQLite-only backup does not contain the media bytes.

The four browser workflows have isolated fixture tests. Actual signed-in LinkedIn/X/Instagram/TikTok acceptance is pending until accounts are connected through the UI and the operator authorizes specific test posts. Platform selector changes, account challenges and native upload rejection may require updates; the worker pauses or records uncertainty instead of inventing success.

Official platform references: [LinkedIn posting](https://www.linkedin.com/help/linkedin/answer/a522602), [LinkedIn photos](https://www.linkedin.com/help/linkedin/answer/a527229/share-photos-or-videos?lang=en), [X web video uploads](https://help.x.com/en/using-x/x-videos), [TikTok browser video scheduling](https://ads.tiktok.com/business/en-US/blog/introducing-video-scheduler-now-you-can-plan-tiktoks-in-advance). These describe the native products; they do not establish that our selectors have passed live-account acceptance.
