# ADR 0006 — Capability-gated social browser automation (Daytona only)

- Status: Accepted
- Date: 2026-11-05
- Supersedes: [ADR 0003](0003-no-social-automation.md)

## Context

ADR 0003 forbade every automated social path in the public engine: social playbook
steps could only be `manual.task`, and no browser automation shipped. Operators still
need two product surfaces that look like Buffer: a content calendar (`social.publish`)
and outreach touches (`social.message`). Official LinkedIn Marketing / Messages partner
APIs are unavailable for v1. Driving those actions from the Mac Papr Chrome profile is
unsafe and couples the desktop session to unattended workers.

The workable placement is a long-lived Daytona sandbox that owns Playwright Chrome, the
SQLite database, and a persistent Chrome profile volume. The Mac keeps only the operator
console.

## Decision

- Supersede ADR 0003's absolute ban. Automated social is allowed **only** when every
  gate below is true; otherwise the compiler and worker refuse the action (no silent
  fallback to email or to a local browser).
- New action kinds: `social.publish` (calendar posts) and `social.message` (DMs /
  connection notes). `manual.task` remains the human fallback when the browser session
  is unhealthy or the operator opts out.
- `ProviderAdapter` gains an optional `social` port (`publish`, `message`, `health`,
  `reconnectNeeded`). A missing port means unsupported — never "try email instead".
- Playbooks may emit those kinds only when the bound provider account declares a
  matching purpose (`social_publishing` / `social_messaging`) **and**
  `executionPlacement: daytona-browser` on the account capability snapshot.
- Execution of the social port runs only inside a Daytona (or equivalent) sandbox with
  a dedicated Chrome user-data-dir. It is never the default for a local Papr desktop
  Chrome session, and the public MIT tree does not ship stealth, anti-detection,
  CAPTCHA, challenge, or 2FA bypass.
- Content campaigns (`ContentCalendar`) materialize only `social.publish` rows onto the
  existing `scheduled_actions` table (slots, quiet hours, per-channel daily caps).
- Official partner API adapters may still be added later behind verified entitlement;
  they do not replace this capability-gated browser path for the Daytona placement.

## Consequences

- Operators sign into LinkedIn (and later other networks) once via Daytona live view;
  cookies live on a Daytona disk volume, not on the Mac.
- Losing the Daytona session or hitting a checkpoint yields `reauth_required` /
  `needs_reconnect` and pauses social actions; it does not retry blindly.
- Email Gmail/Outlook adapters, approvals, suppressions, leases, and the review queue
  stay unchanged.
- ADR 0003 remains on disk as historical context; new code and docs follow this ADR.


## Comprehensive implementation amendment

Automated connection invitations are distinct `social.connect` actions. Trusted
browser recipes use `browser.task`, with fixed origin/selector/identity rules and
a definition hash included in the approved action. Mailbox draft CRUD is a
separate provider port and cannot send mail. Unsupported capabilities remain
false/absent rather than falling back to email.

Production runs only in the configured Linux Daytona runtime, with one supervised
CDP browser and sandbox-local persistent profile per bound external account.
Recipe-only browser accounts advertise no native LinkedIn social capabilities.
Live SQLite WAL and Chrome profiles use persistent sandbox-local disk, not
Daytona managed FUSE volumes. The runtime maintains separate app/preview tokens
and preserves engine authorization independently of preview access.

Only a new native provider receipt confirms success. Preeffect reauthentication
holds the action; post-effect ambiguity goes to review/reconciliation. Editing
approved content, images or recipe parameters requires a fresh approval. Current
contact suppression, account purpose/capabilities, quiet hours, budgets and kill
switches are rechecked before execution. Actual provider and Papr acceptance are
qualified independently of local Chromium fixtures.
