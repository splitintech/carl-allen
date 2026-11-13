import type { DefaultTreeAdapterMap } from 'parse5';
import { WorkPackageManifest, sha256Hex, type WorkManifest, type WorkPackageIssue } from '@splitin/outreach-contracts';
import { selectAll, textOf } from './html';
import { htmlDestination } from './html-action-destination';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
const attr = (element: Element, name: string) => element.attrs.find((item) => item.name === name)?.value ?? '';
const STATUS = [
  { re: /\bconnect\s*first\b/i, tag: 'connect_first' },
  { re: /\bconnection\s*requested\b/i, tag: 'connection_requested' },
  { re: /\breview\s*required\b|\block(?:ed)?\b/i, tag: 'review_required' },
] as const;

/** Join element boundaries with whitespace, including adjacent inline status and link labels. */
function readableText(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return node.value;
  if ('tagName' in node && ['script', 'style', 'template', 'noscript', 'iframe', 'object'].includes(node.tagName)) return '';
  return 'childNodes' in node ? node.childNodes.map(readableText).join(' ') : '';
}

function nearestCard(element: Element): Element | null {
  let current: Node | undefined = element; let fallback: Element | null = null;
  for (let depth = 0; depth < 8 && current; depth++) {
    if ('tagName' in current) {
      if (['article', 'li', 'tr'].includes(current.tagName) || /(?:^|[\s_-])(card|person|contact|profile|row)(?:$|[\s_-])/.test(attr(current, 'class').toLowerCase())) return current;
      if (!fallback && ['div', 'section'].includes(current.tagName)) fallback = current;
    }
    current = 'parentNode' in current ? current.parentNode as Node | undefined : undefined;
  }
  return fallback;
}

function canonicalLinkedIn(raw: string, base?: string): string | null {
  try {
    const destination = htmlDestination(raw, base); if (destination.kind !== 'open_url') return null;
    const url = new URL(destination.href);
    if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.port) return null;
    const match = url.pathname.match(/^\/in\/([a-z0-9_-]+)\/?$/i);
    return match ? `https://www.linkedin.com/in/${match[1]!.toLowerCase()}/` : null;
  } catch { return null; }
}

function emailRecipients(anchor: Element): string[] {
  if (!/^mailto:/i.test(attr(anchor, 'href').trim())) return [];
  try { const destination = htmlDestination(attr(anchor, 'href')); return destination.kind === 'compose_email' ? destination.email.to : []; }
  catch { return []; }
}

export function reportName(root: Node): string {
  const title = selectAll(root, 'title')[0]; const heading = selectAll(root, 'h1')[0];
  return ((title ? textOf(title) : '') || (heading ? textOf(heading) : '') || 'Imported HTML report').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Imported HTML report';
}

/** Infer review data only. Email links never create permission or email-send sequences. */
export function inferContactManifest(root: Node, html: string, issues: WorkPackageIssue[]): WorkManifest | null {
  const anchors = selectAll(root, 'a'); const bases = selectAll(root, 'base'); let base: string | undefined;
  try { if (bases[0]) { const parsed = htmlDestination(attr(bases[0], 'href')); if (parsed.kind === 'open_url') base = parsed.href; } } catch { /* Relative profile links stay unclassified. */ }
  const contacts: WorkManifest['contacts'] = []; const profiles = new Set<string>(); const emails = new Set<string>();
  const cards = new Map<Element, { anchors: Element[]; sources: string[]; profiles: Set<string | null>; emails: string[]; text: string; heading: string }>();
  const cardData = (card: Element | null) => {
    if (!card) return null;
    const existing = cards.get(card); if (existing) return existing;
    const links = selectAll(card, 'a'); const sources: string[] = [];
    for (const link of links) {
      try { const destination = htmlDestination(attr(link, 'href'), base); if (destination.kind === 'open_url' && destination.href.startsWith('https:')) sources.push(destination.href); } catch { /* The action inventory records unsupported destinations. */ }
    }
    const heading = ['h2', 'h3', 'h4', 'strong'].flatMap((tag) => selectAll(card, tag))[0];
    const result = { anchors: links, sources: [...new Set(sources)].slice(0, 50), profiles: new Set(links.map((link) => canonicalLinkedIn(attr(link, 'href'), base)).filter(Boolean)), emails: [...new Set(links.flatMap(emailRecipients))], text: readableText(card).replace(/\s+/g, ' ').trim(), heading: heading ? readableText(heading) : '' };
    cards.set(card, result); return result;
  };
  const sourceLinks = (card: Element | null, own: string[] = []) => [...new Set([...own, ...(cardData(card)?.sources ?? [])])].slice(0, 50);
  const contactName = (anchor: Element, card: Element | null, fallback: string) => {
    return (cardData(card)?.heading || textOf(anchor) || fallback).replace(/\s+/g, ' ').trim().slice(0, 300) || fallback;
  };
  for (const anchor of anchors) {
    const linkedin = canonicalLinkedIn(attr(anchor, 'href'), base); if (!linkedin || profiles.has(linkedin)) continue;
    const card = nearestCard(anchor); const data = cardData(card); const text = data?.text ?? textOf(anchor);
    const status = STATUS.find((item) => item.re.test(text))?.tag;
    const email = data?.profiles.size === 1 && data.emails.length === 1 ? data.emails[0] : undefined;
    contacts.push({ id: `contact-${contacts.length + 1}`, name: contactName(anchor, card, linkedin), linkedin, ...(email ? { email } : {}), sources: sourceLinks(card, [linkedin]), notes: status ? `status:${status}` : '', consentBasis: 'unknown', jurisdiction: 'unknown' });
    profiles.add(linkedin); if (email) emails.add(email.toLowerCase());
  }
  for (const anchor of anchors) for (const email of emailRecipients(anchor)) {
    if (emails.has(email.toLowerCase())) continue;
    const card = nearestCard(anchor);
    contacts.push({ id: `contact-${contacts.length + 1}`, name: contactName(anchor, card, email), email, sources: sourceLinks(card), notes: '', consentBasis: 'unknown', jurisdiction: 'unknown' });
    emails.add(email.toLowerCase());
  }
  if (!contacts.length) return null;
  if (contacts.length > 1000) issues.push({ field: 'contacts', message: 'Contact inference is limited to 1000 people. Split this report to review every contact.', severity: 'warning' });
  const reviewed = contacts.slice(0, 1000); const connectFirst = reviewed.filter((contact) => contact.linkedin && contact.notes === 'status:connect_first');
  issues.push({ field: 'manifest', message: `Inferred ${reviewed.length} contacts from this report. Review the identities and links before preparing outreach.`, severity: 'info' });
  if (connectFirst.length) issues.push({ field: 'intent.connect_first', message: `${connectFirst.length} people are tagged Connect first. Choose a start time and map your LinkedIn account before preparing requests for approval. Nothing sends on import.`, severity: 'info' });
  return WorkPackageManifest.parse({ schemaVersion: 1, packageId: `report-${sha256Hex(html).slice(0, 32)}`, revision: 1, name: reportName(root), timezone: 'America/New_York', contacts: reviewed,
    accountRefs: connectFirst.length ? [{ id: 'linkedin-main', channel: 'linkedin', label: 'LinkedIn account for connection requests' }] : [],
    outreachSequences: connectFirst.length ? [{ id: 'seq-connect-first', name: 'Connect first · LinkedIn', contacts: connectFirst.map((contact) => contact.id), scheduledFor: null, steps: [{ id: 'step-connect', accountRef: 'linkedin-main', channel: 'linkedin', kind: 'connect', text: '', waitHours: 0, waitFor: 'elapsed' }] }] : [],
  });
}
