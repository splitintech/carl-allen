---
name: outreach
description: Operate the SplitIn outreach engine safely from Papr Work — drafting, previews and status; never sending on your own.
---

# Outreach engine — agent rules

The outreach engine is a separate, MIT-licensed service (`outreach` CLI + `outreach serve`). It owns its own database; never write to it with sqlite3 and never put its data in a Papr registry database.

## What you may do

- **Draft**: write or improve templates and playbooks (YAML) as files for the user to review. Use only the tokens the engine allows: `{{first_name}}`, `{{full_name}}`, `{{title}}`, `{{org_name}}`, `{{org_domain}}`, `{{sender_name}}`, `{{sender_email}}`, `{{sender_org}}`, `{{sender_address}}`, `{{unsubscribe_url}}`, `{{attr.<key>}}`.
- **Validate**: `outreach playbook compile <file> --account <id>` and `outreach import preview <file> --profile <id>`. Both change nothing.
- **Report**: `outreach campaign status <id> --json`, `outreach approvals list --json`, `outreach review list --json`, `outreach tasks list --json`.
- **Explain** what a pending approval contains (recipients, subjects, content hash) so the human can decide.

## What you must never do

- Never run `outreach campaign activate`, `outreach approvals approve`, `outreach import commit`, `outreach gate open`, `outreach jurisdiction set`, `outreach review resolve --as sent`, or `outreach kill release` yourself. These are human decisions; ask the user to run them or to click them in the Outreach Console.
- Never invent contacts or email addresses, and never edit an import file to add people who were not in it.
- Prepare reviewed LinkedIn/Instagram outreach and LinkedIn/X/Instagram/TikTok publications through Carl-Allen HTML packages or its authenticated MCP. Browser execution belongs to the Daytona engine after human approval; never perform direct browser sends or assert that a package is approved. Existing legacy manual tasks remain human tasks.
- Never bypass suppressions, the live-send gate, rate limits or send windows, and never try to "unstick" an uncertain send by re-sending it. Uncertain sends are resolved by reconciliation or by a human in the review queue.

## When the user asks to "run outbound"

1. Check there is a provider account and that the purpose fits: `outreach playbook compile`.
2. Preview the import and show the counts and rejected rows.
3. Prepare the campaign (`outreach campaign prepare`) and show the audience count, exclusions and the approval that was requested.
4. Stop. Tell the user exactly which approvals they need to give and where.

## HTML cloud handoff

Retrieve the Carl-Allen template and connected targets, prepare a versioned inert manifest with real source links and accompanying media filenames, and return the authenticated repair/review link. Final approval occurs in Carl-Allen. Inspect package receipts and native results through MCP; a file upload or pending approval is not a published post. Papr/ChatGPT may close after a durable cloud receipt. Zoho supports inbox and draft management only; sending remains manual in Zoho. No separate model API key is required.
