import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import type { HtmlImportAction } from '@splitin/outreach-contracts';
import { extractWorkPackage } from './work-package';
import { extractHtmlActions } from './html-actions';
import { sanitizePreviewStyles } from './document-preview-styles';
import { HTML_DOCUMENT_PREVIEW_BRIDGE, HTML_DOCUMENT_PREVIEW_CSP, HTML_DOCUMENT_PREVIEW_MESSAGE_TYPE, HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE, HTML_DOCUMENT_PREVIEW_STYLES, PREVIEW_OMISSION_MESSAGES, type HtmlPreviewOmission } from './document-preview-policy';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_TAGS = new Set('html head body title style address article aside footer header h1 h2 h3 h4 h5 h6 hgroup main nav section blockquote div dd dl dt figure figcaption hr li ol p pre ul a abbr b bdi bdo br cite code data dfn em i kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr table caption colgroup col tbody td tfoot th thead tr area map img picture audio video canvas input button textarea select option optgroup fieldset legend label meter progress datalist output form details summary dialog menu search'.split(' '));
const DROP = new Set('iframe frame frameset object embed applet portal base meta link template noscript source track'.split(' '));
const SVG_TAGS = new Set('svg g path circle ellipse line polyline polygon rect text tspan defs clipPath mask linearGradient radialGradient stop pattern symbol use title desc style'.split(' '));
const GLOBAL_ATTRS = new Set('id class lang dir title hidden role tabindex'.split(' '));
const HTML_ATTRS = new Set('alt width height colspan rowspan scope headers abbr summary border cellpadding cellspacing align valign bgcolor start reversed value type name placeholder checked selected multiple min max step rows cols size maxlength disabled readonly for open datetime controls preload label low high optimum span wrap'.split(' '));
const SVG_ATTRS = new Set('viewbox width height x y cx cy dx dy r rx ry x1 y1 x2 y2 d points transform fill fill-opacity fill-rule clip-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity gradientunits gradienttransform offset stop-color stop-opacity preserveaspectratio text-anchor font-size font-family'.split(' '));
const URL_ATTRS = new Set('src srcset href ping poster action formaction data background codebase archive cite longdesc manifest profile srcdoc'.split(' '));
const attr = (element: Element, name: string) => element.attrs.find((item) => item.name.toLowerCase() === name)?.value ?? '';
const isElement = (node: Node): node is Element => 'tagName' in node;

export interface HtmlDocumentPreview {
  html: string; sourceHash: string; actions: HtmlImportAction[]; boundActionIds: string[];
  omissions: HtmlPreviewOmission[];
  policy: { sandbox: 'allow-scripts'; messageType: typeof HTML_DOCUMENT_PREVIEW_MESSAGE_TYPE; readyMessageType: typeof HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE; csp: string };
}

function sourceElements(root: Node): Element[] {
  const elements: Element[] = [];
  const visit = (node: Node) => {
    if (isElement(node)) { elements.push(node); if (['template', 'noscript'].includes(node.tagName)) return; }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(root); return elements;
}

/** Bind the extractor's actual source elements; no label, URL, or DOM-order heuristics. */
function actionBindings(root: Node, actions: HtmlImportAction[]): Map<Element, string> {
  const identities = new Map(actions.map((action) => [action.id, action]));
  const result = new Map<Element, string>();
  extractHtmlActions(root, [], (element, action) => {
    const known = identities.get(action.id);
    if (!known || known.kind === 'unsupported' || known.source !== action.source || known.kind !== action.kind || known.href !== action.href || element.namespaceURI !== HTML_NS || element.attrs.some((item) => item.name === 'disabled') || attr(element, 'aria-disabled').toLowerCase() === 'true') return;
    const nativeClick = ['a', 'button'].includes(element.tagName) || element.tagName === 'input' && ['button', 'submit', 'reset'].includes(attr(element, 'type').toLowerCase());
    if (action.source === 'onclick' && nativeClick) result.set(element, action.id);
    else if (action.source === 'anchor' && element.tagName === 'a' && !result.has(element) && !element.attrs.some((item) => /^on[a-z]+$/i.test(item.name))) result.set(element, action.id);
  });
  return result;
}

function rasterDataImage(value: string): boolean {
  if (value.length > 3_000_000) return false;
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) && value.slice(value.indexOf(',') + 1).length % 4 === 0;
}

/** A sanitized view of the original document, never a replacement for its stored source bytes. */
export function buildHtmlDocumentPreview(sourceHtml: string): HtmlDocumentPreview {
  const extracted = extractWorkPackage(sourceHtml);
  const document = parse(sourceHtml); const elements = sourceElements(document);
  const bindings = actionBindings(document, extracted.actions); const boundActionIds: string[] = [];
  const omissions = new Map<string, number>(); let styleBudget = 0;
  const omit = (kind: string) => omissions.set(kind, (omissions.get(kind) ?? 0) + 1);
  const styles = (value: string, inline: boolean) => {
    styleBudget += value.length;
    if (styleBudget > 500_000) { omit('styles'); return ''; }
    return sanitizePreviewStyles(value, inline, () => omit('styles'));
  };
  const cleanAttributes = (element: Element) => {
    const id = bindings.get(element);
    const cleaned: Element['attrs'] = [];
    for (const original of element.attrs) {
      const name = original.name.toLowerCase(); const value = original.value;
      if (name.startsWith('data-carl-') || name === 'nonce' || name === 'integrity' || name === 'is' || name === 'autofocus') continue;
      if (/^on[a-z]+$/.test(name)) { omit('scripts'); continue; }
      if (name === 'style') { const style = styles(value, true); if (style) cleaned.push({ name: 'style', value: style }); continue; }
      if (element.tagName === 'img' && name === 'src' && rasterDataImage(value)) { cleaned.push({ name: 'src', value }); continue; }
      if (element.namespaceURI === SVG_NS && element.tagName === 'use' && name === 'href' && /^#[a-z_][a-z0-9_.:-]*$/i.test(value)) { cleaned.push(original); continue; }
      if (URL_ATTRS.has(name) || original.namespace || original.prefix) { omit(name === 'href' || name === 'action' || name === 'formaction' ? 'navigation' : 'resources'); continue; }
      if (value.length > 20_000 || [...value].some((char) => char.charCodeAt(0) === 0)) { omit('embedded'); continue; }
      const global = GLOBAL_ATTRS.has(name) || /^aria-[a-z-]+$/.test(name) || /^data-[a-z0-9_-]+$/.test(name);
      const permitted = element.namespaceURI === SVG_NS ? SVG_ATTRS.has(name) : HTML_ATTRS.has(name);
      if (!global && !permitted) continue;
      if (element.namespaceURI === SVG_NS && ['fill', 'stroke', 'transform', 'stop-color', 'font-family'].includes(name) && !styles(`${name}:${value}`, true)) continue;
      cleaned.push(original);
    }
    element.attrs = cleaned;
    if (['input', 'select', 'textarea'].includes(element.tagName) && !id) element.attrs.push({ name: 'disabled', value: '' });
    if (element.tagName === 'button') element.attrs = [...element.attrs.filter((item) => item.name !== 'type'), { name: 'type', value: 'button' }];
    if (id) {
      if (element.tagName === 'input') element.attrs = [...element.attrs.filter((item) => !['type', 'readonly'].includes(item.name)), { name: 'type', value: 'button' }];
      element.attrs = [...element.attrs.filter((item) => !['tabindex', 'role'].includes(item.name)), { name: 'data-carl-trigger-id', value: id }, { name: 'tabindex', value: '0' }, { name: 'role', value: 'button' }];
      boundActionIds.push(id);
    }
  };
  const cleanChildren = (parent: Node): void => {
    if (!('childNodes' in parent)) return;
    const retained: Node[] = [];
    for (const child of parent.childNodes) {
      if (!isElement(child)) { if (child.nodeName !== '#comment') retained.push(child); continue; }
      if (child.tagName === 'script') { omit('scripts'); continue; }
      if (DROP.has(child.tagName) || child.namespaceURI !== HTML_NS && child.namespaceURI !== SVG_NS) { omit(['link', 'source', 'track'].includes(child.tagName) ? 'resources' : 'embedded'); continue; }
      if (child.namespaceURI === SVG_NS && !SVG_TAGS.has(child.tagName)) { omit('embedded'); continue; }
      if (child.namespaceURI === HTML_NS && !HTML_TAGS.has(child.tagName)) {
        cleanChildren(child); retained.push(...child.childNodes); omit('embedded'); continue;
      }
      cleanAttributes(child);
      if (child.tagName === 'style') {
        const original = child.childNodes.map((node) => 'value' in node ? node.value : '').join('');
        const safe = styles(original, false); child.childNodes = [{ nodeName: '#text', value: safe, parentNode: child }];
      } else cleanChildren(child);
      if (child.tagName === 'canvas') omit('embedded');
      retained.push(child);
    }
    parent.childNodes = retained as typeof parent.childNodes;
    for (const child of parent.childNodes) if ('parentNode' in child) child.parentNode = parent as DefaultTreeAdapterMap['parentNode'];
  };
  cleanChildren(document);
  const html = elements.find((element) => element.tagName === 'html' && element.namespaceURI === HTML_NS)!;
  const head = elements.find((element) => element.tagName === 'head' && element.namespaceURI === HTML_NS)!;
  html.attrs.push({ name: 'data-carl-preview-source-hash', value: extracted.sourceHash });
  const policyNodes = parseFragment(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_DOCUMENT_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">`).childNodes;
  head.childNodes.unshift(...policyNodes);
  head.childNodes.push(...parseFragment(`<style>${HTML_DOCUMENT_PREVIEW_STYLES}</style>`).childNodes);
  head.childNodes.push(...parseFragment(`<script>${HTML_DOCUMENT_PREVIEW_BRIDGE}</script>`).childNodes);
  return { html: serialize(document), sourceHash: extracted.sourceHash, actions: extracted.actions, boundActionIds,
    omissions: [...omissions].map(([kind, count]) => ({ kind, count, message: PREVIEW_OMISSION_MESSAGES[kind] ?? 'Some original document behavior is unavailable in this view.' })),
    policy: { sandbox: 'allow-scripts', messageType: HTML_DOCUMENT_PREVIEW_MESSAGE_TYPE, readyMessageType: HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE, csp: HTML_DOCUMENT_PREVIEW_CSP } };
}
