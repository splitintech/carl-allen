# Proposed tech-stack entry (not published)

Title: Outreach Engine
Repository: https://github.com/splitintech/outreach-engine
Package scope: @splitin/outreach-*
License: MIT
Status: Development; publication and live acceptance pending

Provider-neutral outreach orchestration with durable scheduling, human approvals,
suppression, reply/bounce/opt-out stops, at-most-once-without-confirmation recovery
and append-only audit. TypeScript/Node, SQLite, CLI, loopback HTTP, Papr Work console
and local stdio MCP. Gmail and Microsoft Graph reference adapters are exercised
against local API fakes. Carl-Allen adds approved Daytona browser execution, HTML work packages and an authenticated remote MCP gateway. Zoho supports reading and drafts only. Live host/provider acceptance and user-managed Cloudflare deployment remain separate gates.

Publish this entry in the website's own repository only after the corresponding
engine release is authorized and verified. Do not advertise live production
acceptance or an npm installation command before the packages actually exist.
