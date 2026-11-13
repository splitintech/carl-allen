import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse, serialize } from 'parse5';
import { buildHtmlDocumentPreview } from './document-preview';
import { HTML_DOCUMENT_PREVIEW_BRIDGE, HTML_DOCUMENT_PREVIEW_CSP, HTML_DOCUMENT_PREVIEW_SCRIPT_HASH, HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE } from './document-preview-policy';
import { selectAll, textOf } from './html';
import { extractHtmlActions } from './html-actions';

const original = `<!doctype html><html lang="en"><head><title>My original research</title>
<style>body{background:#123456;color:#fff}.contact-card{display:grid;grid-template-columns:1fr 2fr;padding:24px;border:1px solid #999}@media(max-width:600px){.contact-card{display:block}}</style></head>
<body><header><h1>SF Bay research</h1><p>Original notes stay inside this file view.</p></header>
<article class="contact-card"><h2>Ada Example</h2><p>Designer in San Francisco</p><a href="https://example.invalid/profile">View profile</a><a href="mailto:ada@example.invalid?subject=Hello">Write email</a></article>
<table><tr><th>Name</th><th>Status</th></tr><tr><td>Ada Example</td><td>Review</td></tr></table>
<svg viewBox="0 0 20 20"><path fill="#ef7828" d="M1 1h18v18H1z"/></svg></body></html>`;

describe('original-document visual preview', () => {
  it('preserves original text, DOM layout, styles, tables, and static SVG with source-bound triggers', () => {
    const preview = buildHtmlDocumentPreview(original); const root = parse(preview.html);
    expect(preview.sourceHash).toBe(createHash('sha256').update(original).digest('hex'));
    expect(preview.html).toContain('class="contact-card"');
    expect(preview.html).toContain('display:grid'); expect(preview.html).toContain('@media');
    expect(textOf(root)).toContain('Designer in San Francisco');
    expect(selectAll(root, 'table')).toHaveLength(1);
    expect(selectAll(root, 'svg')).toHaveLength(1);
    expect(preview.actions.map((action) => action.kind)).toEqual(['open_url', 'compose_email']);
    expect(preview.boundActionIds).toEqual(preview.actions.map((action) => action.id));
    for (const action of preview.actions) expect(preview.html).toContain(`data-carl-trigger-id="${action.id}"`);
    expect(preview.html).not.toContain('href="https://example.invalid/profile"');
    expect(preview.html).not.toContain('href="mailto:');
    expect(preview.policy).toMatchObject({ sandbox: 'allow-scripts', messageType: 'carl-allen-document-action', readyMessageType: 'carl-allen-document-ready', csp: HTML_DOCUMENT_PREVIEW_CSP });
  });

  it('authorizes only one fixed product bridge, independently of uploaded source content', () => {
    const first = buildHtmlDocumentPreview('<a href="https://example.invalid/one">One</a>');
    const second = buildHtmlDocumentPreview('<a href="https://example.invalid/two">Two</a>');
    expect(first.policy.csp).toBe(second.policy.csp);
    expect(HTML_DOCUMENT_PREVIEW_SCRIPT_HASH).toBe(`sha256-${createHash('sha256').update(HTML_DOCUMENT_PREVIEW_BRIDGE).digest('base64')}`);
    expect(first.html.match(/<script>/g)).toHaveLength(1);
    expect(first.html).toContain(`<script>${HTML_DOCUMENT_PREVIEW_BRIDGE}</script>`);
    expect(first.policy.csp).toContain(`script-src '${HTML_DOCUMENT_PREVIEW_SCRIPT_HASH}'`);
    expect(first.policy.csp).toContain("connect-src 'none'");
    expect(first.policy.csp).toContain("form-action 'none'");
    expect(first.policy.csp).not.toContain('unsafe-eval');
  });

  it('acknowledges readiness only after DOM content and selection listeners are ready', () => {
    const preview = buildHtmlDocumentPreview('<p>Original content</p>');
    expect(preview.policy.readyMessageType).toBe(HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE);
    const execute = (state: string, hash: string) => {
      const listeners = new Map<string, () => void>(); const messages: unknown[] = [];
      runInNewContext(HTML_DOCUMENT_PREVIEW_BRIDGE, { document: { documentElement: { getAttribute: () => hash }, readyState: state, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) }, parent: { postMessage: (message: unknown, origin: string) => {
        expect(origin).toBe('*');
        for (const type of ['click', 'keydown', 'submit']) expect(listeners.has(type)).toBe(true);
        messages.push(JSON.parse(JSON.stringify(message)));
      } } });
      return { listeners, messages };
    };
    const loading = execute('loading', preview.sourceHash);
    expect(loading.messages).toEqual([]);
    loading.listeners.get('DOMContentLoaded')!();
    expect(loading.messages).toEqual([{ type: preview.policy.readyMessageType, sourceHash: preview.sourceHash }]);
    expect(execute('complete', preview.sourceHash).messages).toEqual(loading.messages);
    expect(execute('complete', 'invalid-source-hash').messages).toEqual([]);
  });

  it('binds supported click controls while keeping side-effect handlers and embedded duplicates unbound', () => {
    const html = '<object><a href="https://example.invalid/same">Embedded link</a></object><a href="https://example.invalid/same" onclick="unknown()">Dynamic link</a><a href="https://example.invalid/same">Ordinary link</a><button onclick="window.open(\'https://example.invalid/button\')">Button</button>';
    const preview = buildHtmlDocumentPreview(html); const lastAnchor = preview.actions.filter((action) => action.source === 'anchor').at(-1)!;
    const buttonAction = preview.actions.find((action) => action.source === 'onclick' && action.kind === 'open_url')!;
    expect(preview.boundActionIds).toEqual([lastAnchor.id, buttonAction.id]);
    expect(preview.html).not.toContain('<object');
    expect(preview.html).not.toContain('onclick=');
    expect(preview.html).toContain(`data-carl-trigger-id="${lastAnchor.id}"`);
    expect(preview.actions.some((action) => action.source === 'onclick' && action.kind === 'open_url')).toBe(true);
  });

  it('uses exact extractor callbacks for helper-function buttons and rejects forged or unsupported bindings', () => {
    const html = `<script>function compose(){window.location.href='mailto:ada@example.invalid?subject=Hello';} function visit(){window.open('https://example.invalid/visit');}</script>
      <button id="compose" data-carl-trigger-id="html-action-999" onclick="compose()">Compose</button>
      <input id="visit" type="submit" value="Visit" onclick="visit()">
      <a id="precedence" href="https://example.invalid/default" onclick="visit()">Visit handler</a>
      <button disabled onclick="visit()">Disabled source</button><span onclick="visit()">Non-native source</span>
      <button onclick="fetch('/side-effect');visit()">Side effect</button><meta http-equiv="refresh" content="0;url=https://example.invalid/redirect">
      <script>location.href='https://example.invalid/script';</script>`;
    const root = parse(html); const associations: { elementId: string; id: string; source: string }[] = [];
    const actions = extractHtmlActions(root, [], (element, action) => associations.push({ elementId: element.attrs.find((item) => item.name === 'id')?.value ?? '', id: action.id, source: action.source }));
    const preview = buildHtmlDocumentPreview(html);
    expect(preview.actions).toEqual(actions);
    expect(preview.boundActionIds).toEqual(['compose', 'visit', 'precedence'].map((elementId) => associations.find((item) => item.elementId === elementId && item.source === 'onclick')!.id));
    expect(preview.html).not.toContain('data-carl-trigger-id="html-action-999"');
    expect(preview.html).not.toContain('onclick='); expect(preview.html).not.toContain('fetch(');
    expect(preview.html).toContain('id="visit"'); expect(preview.html).toContain('type="button"');
    expect(preview.boundActionIds.every((id) => actions.find((action) => action.id === id)?.source === 'onclick')).toBe(true);
    expect(actions.some((action) => action.source === 'meta_refresh')).toBe(true);
    expect(actions.some((action) => action.source === 'script')).toBe(true);
  });

  it('strips original scripts, handlers, reserved bridge attributes, iframe srcdoc, popups, and form submission', () => {
    const hostile = `<html data-carl-preview-source-hash="fake"><head><base href="https://example.invalid/"><meta http-equiv="refresh" content="0;url=https://example.invalid/redirect"><link rel="stylesheet" href="https://example.invalid/style.css"></head><body onload="parent.stolen=true">
      <script nonce="pretend">globalThis.__originalScriptExecuted=true;parent.location='https://example.invalid/escape';</script>
      <iframe srcdoc="<script>parent.postMessage('forged','*')</script>"></iframe>
      <span data-carl-trigger-id="html-action-999">Forged trigger</span>
      <a href="https://example.invalid/real" target="_top" ping="https://example.invalid/ping" download>Real</a>
      <form action="https://example.invalid/submit" method="post" target="_top"><input name="message" value="Original draft"><button type="submit" formaction="https://example.invalid/send">Submit</button></form></body></html>`;
    const preview = buildHtmlDocumentPreview(hostile);
    expect(preview.html).not.toContain('__originalScriptExecuted');
    expect(preview.html).not.toContain('onload='); expect(preview.html).not.toContain('srcdoc=');
    expect(preview.html).not.toContain('<iframe'); expect(preview.html).not.toContain('<base'); expect(preview.html).not.toContain('<link');
    expect(preview.html).not.toContain('http-equiv="refresh"');
    expect(preview.html).not.toContain('target='); expect(preview.html).not.toContain('ping='); expect(preview.html).not.toContain('download');
    expect(preview.html).not.toContain('action='); expect(preview.html).not.toContain('formaction=');
    expect(preview.html).not.toContain('data-carl-trigger-id="html-action-999"');
    expect(preview.html).not.toContain('nonce=');
    expect(preview.html).toContain('type="button"'); expect(preview.html).toContain('disabled');
    expect(preview.omissions.map((item) => item.kind)).toEqual(expect.arrayContaining(['scripts', 'resources', 'embedded', 'navigation']));
  });

  it('blocks CSS resource functions, escaped fetch constructs, imports, fonts, and legacy executable properties', () => {
    const preview = buildHtmlDocumentPreview('<style>@import "https://example.invalid/css";@font-face{font-family:remote;src:url(https://example.invalid/font)}.safe{display:flex;color:red;background-image:url(//example.invalid/img);background: u\\72l(https://example.invalid/escaped);list-style:image-set("https://example.invalid/set" 1x);behavior:expression(alert(1));--hidden:url(https://example.invalid/hidden)}@supports(display:grid){.grid{display:grid}}</style><p class="safe" style="padding:12px;background:url(https://example.invalid/inline);color:blue">Original words</p>');
    expect(preview.html).toContain('display:flex'); expect(preview.html).toContain('color:red');
    expect(preview.html).toContain('padding:12px'); expect(preview.html).toContain('color:blue'); expect(preview.html).toContain('@supports');
    expect(preview.html).not.toContain('@import'); expect(preview.html).not.toContain('@font-face');
    expect(preview.html).not.toContain('example.invalid'); expect(preview.html).not.toContain('expression(');
    expect(preview.omissions.some((item) => item.kind === 'styles' && item.count >= 6)).toBe(true);
  });

  it('retains bounded raster data images while omitting SVG data, remote images, and responsive sources', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yD3sAAAAASUVORK5CYII=';
    const preview = buildHtmlDocumentPreview(`<img src="${png}" alt="Inline sample"><img src="https://example.invalid/remote.png" srcset="https://example.invalid/2x.png 2x" alt="Remote sample"><img src="data:image/svg+xml,<svg onload='alert(1)'/>" alt="SVG sample">`);
    expect(preview.html).toContain(png);
    expect(preview.html).not.toContain('remote.png'); expect(preview.html).not.toContain('srcset=');
    expect(preview.html).not.toContain('data:image/svg+xml');
    expect(preview.html).toContain('alt="Remote sample"'); expect(preview.omissions.some((item) => item.kind === 'resources')).toBe(true);
  });

  it('keeps static SVG geometry while removing SVG scripts, foreignObject, resource links, and animation', () => {
    const preview = buildHtmlDocumentPreview('<svg onload="alert(1)"><defs><symbol id="mark"><path d="M0 0h4v4z"/></symbol></defs><use href="#mark"/><use href="https://example.invalid/external.svg#mark"/><script>alert(1)</script><foreignObject><iframe src="https://example.invalid/frame"></iframe></foreignObject><image href="https://example.invalid/img"/><animate attributeName="href" values="javascript:alert(1)"/><rect width="4" height="4" fill="url(https://example.invalid/fill)"/></svg>');
    expect(preview.html).toContain('<path'); expect(preview.html).toContain('href="#mark"');
    expect(preview.html).not.toContain('example.invalid'); expect(preview.html).not.toContain('javascript:');
    expect(preview.html).not.toContain('foreignObject'); expect(preview.html).not.toContain('<animate');
    expect(preview.html).not.toContain('onload=');
  });

  it('remains inert after parsing and serializing malformed namespace payloads again', () => {
    const preview = buildHtmlDocumentPreview('<math><mtext><table><mglyph><style><!--</style><img title="--><img src=https://example.invalid/x onerror=alert(1)>"></table></mtext></math><svg><desc><![CDATA[</desc><script>alert(2)</script>]]></svg><p>Original text</p>');
    const reparsed = serialize(parse(preview.html));
    expect(reparsed).not.toContain('onerror='); expect(reparsed).not.toContain('alert(1)'); expect(reparsed).not.toContain('alert(2)');
    expect(reparsed).not.toContain('<math'); expect(reparsed).not.toContain('src="https://');
    expect(textOf(parse(reparsed))).toContain('Original text');
  });
});
