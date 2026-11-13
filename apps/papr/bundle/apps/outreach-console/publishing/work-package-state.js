/* global URL */
export const issueText = (issue) => typeof issue === 'string' ? issue : issue.message || issue.reason || 'Needs review';
export function issueSeverity(issue) {
  if (issue?.severity) return issue.severity;
  // Older saved reports used issues for these two successful inference messages.
  if (typeof issue === 'object' && (String(issue.field || '').startsWith('intent.') || (issue.field === 'manifest' && /^Inferred \d+ LinkedIn profiles from this report\./.test(issue.message || '')))) return 'info';
  return 'error';
}
export function splitIssues(issues = []) {
  return { blocking: issues.filter((issue) => issueSeverity(issue) === 'error'), notes: issues.filter((issue) => issueSeverity(issue) !== 'error') };
}
export function receiptSummary(pack) {
  const receipt = pack.cloudReceipt || {};
  if (receipt.placement === 'daytona' && receipt.originalRemoteReady === true) return 'Original HTML saved in Daytona';
  if (receipt.placement === 'daytona' && receipt.originalRemoteReady === false) return 'HTML saved; cloud file storage needs attention';
  if (receipt.placement === 'local') return 'HTML saved locally';
  return 'HTML saved; cloud storage confirmation unavailable';
}
export function safeActionHref(raw, kind = 'open_url') {
  if (typeof raw !== 'string' || !raw || raw.length > 30000 || [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    decodeURIComponent(raw);
    const url = new URL(raw);
    if (kind === 'open_url') return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    if (kind !== 'compose_email' || url.protocol !== 'mailto:' || url.host || url.hash || url.pathname.startsWith('//')) return null;
    const recipientFields = [decodeURIComponent(url.pathname)]; const seen = new Set();
    for (const [key, value] of url.searchParams) {
      const header = key.toLowerCase();
      if (!['to', 'cc', 'bcc', 'subject', 'body'].includes(header) || seen.has(header)) return null;
      seen.add(header);
      if ([...value].some((char) => { const code = char.charCodeAt(0); return code === 127 || code < 32 && (header !== 'body' || ![9, 10, 13].includes(code)); })) return null;
      if (header === 'subject' && value.length > 1000 || header === 'body' && value.length > 20000) return null;
      if (['to', 'cc', 'bcc'].includes(header)) recipientFields.push(value);
    }
    const emails = recipientFields.filter(Boolean).join(',').split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    if (recipientFields.some((value) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null;
    if (emails.length > 100 || emails.some((email) => email.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) return null;
    return url.href;
  } catch { return null; }
}
export function emailHref(email) {
  return typeof email === 'string' && email.trim() ? safeActionHref(`mailto:${encodeURIComponent(email.trim())}`, 'compose_email') : null;
}
