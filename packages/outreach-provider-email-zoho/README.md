# Zoho Mail inbox and drafts

Connect normal business correspondence through Zoho OAuth. This adapter deliberately has no email sender port, no automated-send capability and no fallback through SMTP or browser clicks. It exposes mailbox identity health, bounded inbox synchronization and human-authored draft list/get/save/delete. Send manually in Zoho Mail.

Install/build the monorepo, configure a Zoho OAuth client with a loopback redirect, then use exported `authorizeZoho({clientId,clientSecret,region,onUrl})`. Store the resulting grant in an owner-only file behind the account secret reference. The grant contains clientId/clientSecret/refreshToken/accountId/region. Regional API and authorization domains are allowlisted. Never place grants inside an HTML work package or browser bundle.

Scopes: ZohoMail.accounts.READ, ZohoMail.folders.READ, ZohoMail.messages.READ, ZohoMail.messages.CREATE, ZohoMail.messages.DELETE. The create scope can technically reach send APIs; this adapter additionally restricts every POST to fixed mode=draft and provides no send interface. Unknown drafts and non-Drafts-folder deletion are refused. Editing a draft creates an acknowledged replacement then moves the original to trash; deletion failure reports both drafts without losing the original. Attachment/CC/BCC drafts require native Zoho editing.

Supported regions: US, EU, India, Australia, Japan and Canada. Configure OUTREACH_ZOHO_REGION for the runtime. API errors hold work/reconnect rather than disclosing tokens. Inbox synchronization fetches full provider content and converts supported HTML bodies to inert text; complex or unsupported attachments remain in the native mailbox. OAuth and mailbox operations require live-account acceptance after configuration.

Official contracts: [draft save](https://www.zoho.com/mail/help/api/post-save-draft-template.html), [read/search](https://www.zoho.com/mail/help/api/get-search-emails.html), [delete](https://www.zoho.com/mail/help/api/delete-email.html), [usage boundary](https://www.zoho.com/mail/help/usage-policy.html).
