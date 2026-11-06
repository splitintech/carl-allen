# ADR 0003 — No social-network automation; social steps are manual tasks

- Status: Superseded by [ADR 0006](0006-capability-gated-social-browser.md)
- Date: 2026-09-28
- Superseded-Date: 2026-11-05

## Context

The original plan included scheduled LinkedIn connection-request and DM workers driving
a logged-in browser. LinkedIn's User Agreement prohibits unauthorized automated access,
contact additions and messaging. Its Invitations and Messages APIs are limited to
approved partners, and the Messages API requires a member's contemporaneous action for
each send. Browser feasibility is not permission, and the failure mode is losing the
operator's account.

## Decision

- Playbooks may include social steps only as `manual.task`. The compiler rejects any
  other step type on a social channel.
- A manual task stores the target profile URL and a rendered, editable draft. A host may
  open the URL for the human; opening is the only browser action allowed.
- Only an authenticated principal can mark a manual task `done` or `skipped`. No code
  path completes one automatically.
- The engine contains no stealth, anti-detection, CAPTCHA, challenge or 2FA handling,
  and no scraping.
- An official social API adapter may be added later only behind a verified entitlement,
  as a new ADR. It may never fall back to browser automation.

## Consequences

- Social touches cost human time. Reminders, drafts and a task queue keep that cost low.
- The engine is safe to publish and run against real accounts.
- Hosts such as Papr Work may ship their own social automation; this project neither
  depends on nor extends it.

## Supersession

ADR 0006 allows capability-gated `social.publish` / `social.message` **only** for a
declared `daytona-browser` execution placement, with no stealth tooling and with
`manual.task` retained as the human fallback. The absolute ban above no longer applies
to that gated path.
