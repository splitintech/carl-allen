import { describe, expect, it } from 'vitest';
import { HtmlImportAction, WorkPackageManifest } from '@splitin/outreach-contracts';
import { extractWorkPackage } from './work-package';

const contactsReport = `<title>SF Bay Area LinkedIn Outreach</title>
<article class="card"><h2>Ada Example</h2><a href="https://www.linkedin.com/in/Ada-Example/?trk=research">Profile</a><span>Connect first</span><a href="mailto:ada@example.invalid?subject=Hello&amp;body=Reviewed%20draft">Email Ada</a><a href="https://example.invalid/research">Research source</a></article>
<article class="card"><a href="https://www.linkedin.com/in/ben-example/">Ben Example</a><span>connection requested</span></article>
<article class="card"><a href="https://www.linkedin.com/in/cy-example/">Cy Example</a><span>Connect first</span></article>`;

describe('HTML navigation and compose-email inventory', () => {
  it('retains profile, website, and email actions independently from inferred outreach', () => {
    const result = extractWorkPackage(contactsReport);
    expect(result.manifest?.name).toBe('SF Bay Area LinkedIn Outreach');
    expect(result.manifest?.contacts).toHaveLength(3);
    expect(result.manifest?.contacts[0]).toMatchObject({ name: 'Ada Example', linkedin: 'https://www.linkedin.com/in/ada-example/', email: 'ada@example.invalid', consentBasis: 'unknown', notes: 'status:connect_first' });
    expect(result.manifest?.contacts[0]?.sources).toContain('https://example.invalid/research');
    expect(result.manifest?.outreachSequences).toHaveLength(1);
    expect(result.manifest?.outreachSequences[0]).toMatchObject({ contacts: ['contact-1', 'contact-3'], scheduledFor: null });
    expect(result.manifest?.outreachSequences[0]?.steps[0]?.kind).toBe('connect');
    expect(result.actions.filter((action) => action.kind === 'open_url')).toHaveLength(4);
    expect(result.actions.filter((action) => action.kind === 'compose_email')).toHaveLength(1);
    expect(result.issues.every((issue) => issue.severity === 'info')).toBe(true);
    for (const action of result.actions) expect(HtmlImportAction.safeParse(action).success).toBe(true);
  });

  it('preserves recipients and draft fields, escaped ampersands, plus signs, and line breaks', () => {
    const result = extractWorkPackage('<a href="mailto:ada%2Bwork@example.invalid,ben@example.invalid?cc=cy+work%40example.invalid&amp;bcc=dee%40example.invalid&amp;subject=Hello%20%26%20welcome&amp;body=Line%201%0ALine%202">Write email</a>');
    expect(result.actions[0]).toMatchObject({ kind: 'compose_email', email: { to: ['ada+work@example.invalid', 'ben@example.invalid'], cc: ['cy+work@example.invalid'], bcc: ['dee@example.invalid'], subject: 'Hello & welcome', body: 'Line 1\nLine 2' } });
    const action = result.actions[0]!;
    if (action.kind === 'compose_email') {
      expect(action.href).toContain('ada%2Bwork@example.invalid');
      expect(action.href).toContain('body=Line%201%0ALine%202');
    }
    expect(result.manifest?.contacts).toHaveLength(2);
    expect(result.manifest?.accountRefs).toEqual([]);
    expect(result.manifest?.outreachSequences).toEqual([]);
  });

  it('accepts manual URL-only reports without requiring an execution manifest or account mapping', () => {
    const result = extractWorkPackage('<title>My references</title><a href="http://example.invalid/booking?x=1&amp;y=2">Book meeting</a>');
    expect(result.manifest?.name).toBe('My references');
    expect(result.manifest?.accountRefs).toEqual([]);
    expect(result.manifest?.outreachSequences).toEqual([]);
    expect(result.actions).toMatchObject([{ kind: 'open_url', href: 'http://example.invalid/booking?x=1&y=2', label: 'Book meeting', source: 'anchor' }]);
    expect(result.issues).toMatchObject([{ severity: 'info' }]);
  });

  it('resolves relative destinations only with an absolute HTTP(S) base', () => {
    const result = extractWorkPackage('<base href="https://example.invalid/docs/"><a href="../booking">Book</a><a href="//other.example.invalid/">Other</a>');
    expect(result.actions.map((action) => action.kind === 'open_url' ? action.href : null)).toEqual(['https://example.invalid/booking', 'https://other.example.invalid/']);
    const unresolved = extractWorkPackage('<a href="/in/ada">Not necessarily LinkedIn</a><a href="#section">Section</a>');
    expect(unresolved.manifest).toBeNull();
    expect(unresolved.actions.every((action) => action.kind === 'unsupported')).toBe(true);
    expect(extractWorkPackage('<base href="javascript:alert(1)"><a href="/next">Next</a>').issues.some((issue) => issue.field === 'html.base')).toBe(true);
  });

  it('retains table links as actions as well as mapping values', () => {
    const result = extractWorkPackage('<table><tr><th>Name</th><th>Email</th></tr><tr><td>Ada</td><td><a href="mailto:ada@example.invalid?subject=Hello">Email Ada</a><a href="https://example.invalid/info">Info</a></td></tr></table>');
    expect(result.tables[0]?.[0]?.['Email link']).toBe('mailto:ada@example.invalid?subject=Hello');
    expect(result.actions.map((action) => action.kind)).toEqual(['compose_email', 'open_url']);
    expect(result.manifest?.contacts[0]?.email).toBe('ada@example.invalid');
  });

  it('inventories literal onclick, helper-function, script, and meta redirects without execution', () => {
    const html = `<script>function emailPerson(address) { const prefix = 'mailto:'; window.location.href = prefix + address; } const openReference = () => { window.open('https://example.invalid/reference', '_blank'); };</script>
      <button onclick="emailPerson('ada@example.invalid'); return false">Email Ada</button>
      <a href="#" onclick="return openReference()">Reference</a>
      <button onclick="location.assign('https://example.invalid/assign')">Assign</button>
      <button onclick="window.location.replace('https://example.invalid/replace')">Replace</button>
      <script>window.location = 'https://example.invalid/script';</script>
      <meta http-equiv="refresh" content="5; url='https://example.invalid/meta'">`;
    const result = extractWorkPackage(html);
    expect(result.actions.map((action) => action.kind)).toEqual(['compose_email', 'open_url', 'open_url', 'open_url', 'open_url', 'open_url']);
    expect(result.actions.map((action) => action.source)).toEqual(['onclick', 'onclick', 'onclick', 'onclick', 'script', 'meta_refresh']);
    expect(result.actions[0]).toMatchObject({ href: 'mailto:ada@example.invalid' });
  });

  it('does not infer one email address for unrelated profiles in the same loose container', () => {
    const result = extractWorkPackage('<div><a href="https://www.linkedin.com/in/ada/">Ada</a><a href="https://www.linkedin.com/in/ben/">Ben</a><a href="mailto:unknown@example.invalid">Mailbox</a></div>');
    expect(result.manifest?.contacts).toHaveLength(3);
    expect(result.manifest?.contacts.slice(0, 2).every((contact) => contact.email === undefined)).toBe(true);
  });

  it('supports null or omitted inferred sequence dates while preserving explicit ISO dates', () => {
    const manifest = extractWorkPackage(contactsReport).manifest!;
    const raw = { ...manifest, outreachSequences: manifest.outreachSequences.map(({ scheduledFor: _scheduledFor, ...sequence }) => sequence) };
    expect(WorkPackageManifest.parse(raw).outreachSequences[0]?.scheduledFor).toBeNull();
    expect(WorkPackageManifest.parse({ ...manifest, outreachSequences: [{ ...manifest.outreachSequences[0], scheduledFor: '2099-01-01T10:00:00Z' }] }).outreachSequences[0]?.scheduledFor).toBe('2099-01-01T10:00:00Z');
  });
});

describe('unsupported and malicious HTML interactions', () => {
  it.each([
    'javascript:window.open("https://example.invalid")', 'data:text/html,bad', 'file:///private/example',
    'https://user:password@example.invalid/', 'java\tscript:alert(1)', 'mailto:ada%0A@example.invalid',
    'mailto:ada@example.invalid?subject=Hi%0D%0ABcc%3Ahidden%40example.invalid',
    'mailto:ada@example.invalid?attach=file%3A%2F%2F%2Fprivate%2Fexample', 'mailto:ada@example.invalid?subject=%E0%A4',
    'mailto:ada@example.invalid?subject=one&subject=two', 'mailto:ada@example.invalid?body=%00',
  ])('keeps unsafe or malformed destination inert: %s', (href) => {
    const result = extractWorkPackage(`<a href='${href.replace(/'/g, '&#39;')}'>Link</a>`);
    expect(result.actions[0]?.kind).toBe('unsupported');
    expect(result.actions[0]).not.toHaveProperty('href');
  });

  it.each([
    "window.open('https://example.invalid'); fetch('https://example.invalid/leak')",
    "location.href = getDestination()", "window.open(`https://${unknown}/`)",
    "window.open('https://example.invalid'); location.href='https://other.invalid'",
    "return false; location.href='https://example.invalid'", "setTimeout(()=>window.open('https://example.invalid'),0)",
  ])('does not partially accept a handler with dynamic or additional effects: %s', (handler) => {
    const result = extractWorkPackage(`<button onclick="${handler.replace(/"/g, '&quot;')}">Go</button>`);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe('unsupported');
  });

  it('rejects helper functions with side effects, conflicting declarations, and recursion', () => {
    const result = extractWorkPackage(`<script>function sideEffect() { fetch('/leak'); window.open('https://example.invalid'); } function duplicate(){ location.href='https://one.invalid'; } function duplicate(){ location.href='https://two.invalid'; } function recurse(){ return recurse(); }</script><button onclick="sideEffect()">Side effect</button><button onclick="duplicate()">Conflicting</button><button onclick="recurse()">Recursive</button>`);
    expect(result.actions.filter((action) => action.source === 'onclick')).toHaveLength(3);
    expect(result.actions.every((action) => action.kind === 'unsupported')).toBe(true);
  });

  it('lists complex script functions even when no static click reference was found', () => {
    const result = extractWorkPackage('<script>function drawGraph(data) { document.querySelector("canvas").draw(data); }</script>');
    expect(result.actions).toMatchObject([{ kind: 'unsupported', source: 'script' }]);
  });

  it.each([
    ["function go(location) { location.href='https://example.invalid'; }", "go('shadowed')"],
    ["function go(window) { window.open('https://example.invalid'); }", "go('shadowed')"],
    ["function go() { const location='shadowed'; location.href='https://example.invalid'; }", 'go()'],
    ["const location='shadowed';", "location.href='https://example.invalid'"],
    ["function go(){window.open('https://example.invalid');} go=dynamic;", 'go()'],
    ["function go(){window.open('https://example.invalid');} window.go=dynamic;", 'go()'],
    ["function go(){window.open('https://example.invalid');} window['go']=dynamic;", 'go()'],
    ["window.open=dynamic;", "window.open('https://example.invalid')"],
  ])('does not assume shadowed or reassigned browser helpers: %s', (script, handler) => {
    const result = extractWorkPackage(`<script>${script}</script><button onclick="${handler}">Go</button>`);
    expect(result.actions.filter((action) => action.source === 'onclick')).toMatchObject([{ kind: 'unsupported' }]);
  });

  it('inventories external scripts, dynamic generated content, forms, embedded content, and other events', () => {
    const result = extractWorkPackage('<script src="https://example.invalid/code.js"></script><script>globalThis.__carlHtmlExecuted=true;document.write("<a href=\\"https://example.invalid\\">Dynamic</a>")</script><form action="https://example.invalid/submit"><input name="data"></form><iframe src="https://example.invalid/frame"></iframe><button onmouseover="alert(1)">Hover</button>');
    expect(result.actions).toHaveLength(5);
    expect(result.actions.every((action) => action.kind === 'unsupported')).toBe(true);
    expect(result.text).not.toContain('__carlHtmlExecuted');
    expect((globalThis as Record<string, unknown>).__carlHtmlExecuted).toBeUndefined();
  });

  it('keeps invalid embedded manifest errors visible even when manual links are valid', () => {
    const result = extractWorkPackage('<script type="application/json" id="carl-allen-manifest">{"approved":true}</script><a href="https://example.invalid/">Source</a>');
    expect(result.manifest).toBeNull();
    expect(result.issues.some((issue) => issue.severity !== 'info')).toBe(true);
    expect(result.actions[0]?.kind).toBe('open_url');
  });

  it('caps action inventory explicitly instead of silently truncating coverage', () => {
    const result = extractWorkPackage('<a href="https://example.invalid/">Link</a>'.repeat(1010));
    expect(result.actions).toHaveLength(1000);
    expect(result.actions.at(-1)).toMatchObject({ kind: 'unsupported', source: 'document' });
    expect(result.issues.some((issue) => issue.field === 'html.actions' && issue.severity === 'warning')).toBe(true);
  });
});
