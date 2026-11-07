# Carl-Allen HTML handoffs, monthly publishing and cloud outreach implementation

User explicitly requests implementation of the comprehensive agreed plan. Target: private team application carl-allen.splitin.net. Research occurs in Papr/ChatGPT; upload standard manifest HTML or arbitrary reports with guided repair plus local media; server-side review and approval; deterministic publishing/outreach/reply playbooks execute in Daytona with Mac off. No new model API or cloud research agent.

## Agreed scope

10 social targets, 1000 publications/month, 50GB private media; 90-day scheduling horizon; 72h pending decision deadline separate from approved execution validity; missed publication slots over1h return to review. Multiple same-platform targets; LinkedIn personal/company identities, Instagram Business/Creator, X and TikTok; supported feed/carousel/video/reels/first comments. Gmail/Outlook sending with purpose/gates; Zoho inbox and drafts only. Unified conversations, coordinated follow-ups, cross-channel stop-on-reply/opt-out, deterministic approved reply rules. Private team roles admin/operator/approver/viewer; Google-only sign-in and scoped OAuth MCP. All final approvals in Carl-Allen.

## Implementation sequence and evidence gates

1. Preserve primary checkout; isolate current remote main. Record source/runtime/database/auth configuration baseline and requirement-level ledger.
2. Forward-only migrations for work packages/revisions, targets/connection identity, plan authorizations, membership, conversations/assignments, sequence events/reply playbooks. Backward-compatible existing draft/action APIs and cursor/date-filtered lists.
3. Inert HTML manifest parser, versioned schema, arbitrary table/text mapping and repair, account/media resolution, idempotent revisions and diffs, stored original plus durable completeness receipt. Never execute uploaded scripts or accept approval/credentials from documents.
4. Separate plan approval scope hashing accounts/recipients/rendered content/media/schedules/policy, edit invalidation, 90-day schedule, monthly batch review/cap forecasting, >1h missed-slot review; legacy approvals unchanged.
5. Independent login and publishing identities, same-platform target IDs, per-login serialization, at most2 active persistent browser processes, supervised pool/readiness, identity/recipient checks and uncertainty without blind retries.
6. R2 private immutable media adapter with local compatibility, 50GB quota/reservations/resumable uploads/hash finalization, bounded execution staging, reference protection, cleanup and recovery artifacts.
7. Dark Buffer-reference Carl-Allen UI: Home/Create/Publish/People/Outreach/Inbox/Insights/Settings. Account sidebar, month/week/list, timezone/tags/undated/status filters, multi-account chips, split composer/native previews/first comments, sticky save/review, responsive and accessible real states. Modular source builds one self-contained HTML.
8. Reviewed LinkedIn/Instagram browser outreach and Gmail/Outlook sequences, wait conditions, cross-channel reply/opt-out stop, fresh inbox monitoring/cursors, approved bounded deterministic response rules, unmatched human inbox, Zoho OAuth/read/draft CRUD only.
9. Reuse existing Carl-Allen MCP domain/tools; authenticated stateless Streamable HTTP, OAuth discovery/PKCE/audience/scopes, Papr remote connection/grants, ChatGPT personal/team acceptance, template/import/review links/status, no MCP final approval; preserve stdio and update stale Papr docs.
10. Cloudflare Worker/static HTML/private R2/auth gateway/custom domain, cloud-side private runtime credential refresh, in-place Daytona upgrade with backup/rollback, synthetic/accelerated checks then explicitly authorized live accounts/content, Mac-off/pilot acceptance, isolated PR/CI/Git deployment receipts.

## Validation and safety invariants

Test malformed/hostile/duplicate HTML, guided repair, missing media, tenant isolation, day20/day31 approvals, edited/revoked approvals, multiple LinkedIn/Instagram identities, DST/timezone/pagination/missed slots, resumable/corrupt/expired/overquota media, account serialization/checkpoint/uncertain effects, reply dedup/suppression/monitor staleness/loops, no Zoho send, OAuth/MCP scope/expiry/auth discovery, real Chromium UI and native workflow fixtures, 1000-post and50GB accounting, restart and Mac-off execution. Record source/tests/deployment/live human acceptance separately. Preserve credentials/browser profiles/DB/private context outside product Git. No real send is implied by implementation tests; live tests require named approved content/recipients/accounts.

Use frontend-design, web-design-guidelines and openai-docs skills. Provided screenshots are design source; Mobbin paid-plan refusal is already known. Never copy private company snapshot into product repo. Requirement ledger must reflect actual evidence and remaining external configuration, never mark completion from stub APIs or fixtures alone.

User steering: Google-only sign-in supersedes passwordless email/Auth0. The user will deploy Cloudflare; deliver tested code and deployment instructions without creating cloud resources or changing DNS.
