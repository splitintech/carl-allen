import type { DefaultTreeAdapterMap } from 'parse5';
import type { HtmlImportAction, WorkPackageIssue } from '@splitin/outreach-contracts';
import { textOf } from './html';
import { htmlDestination } from './html-action-destination';
import { parseNavigationScript, registerNavigationFunctions, invalidateNavigationBindings, staticNavigation, type NavigationFunctions } from './html-static-navigation';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type SupportedAction = Exclude<HtmlImportAction, { kind: 'unsupported' }>;
const LIMIT = 1000;
const attr = (element: Element, name: string) => element.attrs.find((item) => item.name === name)?.value ?? '';
const scriptText = (element: Element) => element.childNodes.map((child) => 'value' in child ? child.value : '').join('');
const scriptType = (element: Element) => attr(element, 'type').trim().toLowerCase();
const executableScript = (element: Element) => !scriptType(element) || ['text/javascript', 'application/javascript', 'module'].includes(scriptType(element));

function elementsIn(root: Node): Element[] {
  const result: Element[] = [];
  const visit = (node: Node) => {
    if ('tagName' in node) {
      result.push(node);
      if (['template', 'noscript'].includes(node.tagName)) return;
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(root); return result;
}

/** Inventory safe user-click actions. Unsupported behavior is visible and never evaluated. */
export function extractHtmlActions(root: Node, issues: WorkPackageIssue[], onActionElement?: (element: Element, action: SupportedAction) => void): HtmlImportAction[] {
  const elements = elementsIn(root); const actions: HtmlImportAction[] = [];
  let omitted = 0; let analysedCharacters = 0;
  const functions: NavigationFunctions = new Map(); const scripts = new Map<Element, string>();
  const baseElement = elements.find((element) => element.tagName === 'base' && attr(element, 'href'));
  let base: string | undefined;
  if (baseElement) {
    try { const destination = htmlDestination(attr(baseElement, 'href')); if (destination.kind === 'open_url') base = destination.href; }
    catch { issues.push({ field: 'html.base', message: 'Relative links need a valid absolute HTTP(S) document base.', severity: 'warning' }); }
  }
  const labelFor = (element: Element, fallback: string) => (attr(element, 'aria-label') || attr(element, 'title') || attr(element, 'alt') || textOf(element).replace(/\s+/g, ' ').trim() || fallback).slice(0, 500);
  const unsupported = (label: string, source: string, reason: string) => {
    if (actions.length >= LIMIT - 1) { omitted++; return; }
    actions.push({ id: `html-action-${actions.length + 1}`, kind: 'unsupported', label, source, reason });
  };
  const navigation = (destination: string, label: string, source: string, element: Element) => {
    if (actions.length >= LIMIT - 1) { omitted++; return; }
    let resolved: ReturnType<typeof htmlDestination>;
    try { resolved = htmlDestination(destination, base); }
    catch (error) { unsupported(label, source, error instanceof Error ? error.message : 'Destination requires explicit mapping'); return; }
    const action = { id: `html-action-${actions.length + 1}`, label, source, ...resolved };
    actions.push(action); onActionElement?.(element, action);
  };
  for (const element of elements) {
    if (element.tagName !== 'script' || !executableScript(element) || attr(element, 'src')) continue;
    const code = scriptText(element); analysedCharacters += code.length;
    if (analysedCharacters > 300_000) continue;
    scripts.set(element, code);
    const program = parseNavigationScript(code); if (program) registerNavigationFunctions(program, functions);
  }
  for (const code of scripts.values()) { const program = parseNavigationScript(code); if (program) invalidateNavigationBindings(program, functions); }
  for (const element of elements) {
    let clickNavigates = false;
    for (const handler of element.attrs.filter((item) => /^on[a-z]+$/.test(item.name))) {
      const label = labelFor(element, `${element.tagName} interaction`);
      if (handler.name !== 'onclick') { unsupported(label, handler.name, 'This event requires explicit mapping; event code was not executed'); continue; }
      analysedCharacters += handler.value.length;
      const parsed = analysedCharacters <= 500_000 ? staticNavigation(handler.value, functions) : { reason: 'Document exceeds the static analysis limit' };
      if (parsed.destination !== undefined) { navigation(parsed.destination, label, 'onclick', element); clickNavigates = true; }
      else unsupported(label, 'onclick', parsed.reason ?? 'This click handler requires explicit mapping');
    }
    if (['a', 'area'].includes(element.tagName) && element.attrs.some((item) => item.name === 'href')) {
      const href = attr(element, 'href');
      if (!(clickNavigates && (!href || href.startsWith('#')))) navigation(href, labelFor(element, 'Open link'), 'anchor', element);
    }
    if (element.tagName === 'meta' && attr(element, 'http-equiv').toLowerCase() === 'refresh') {
      const match = attr(element, 'content').match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i);
      if (match?.[1]) {
        const target = match[1].replace(/^(['"])(.*)\1$/, '$2'); navigation(target, 'Open redirect destination', 'meta_refresh', element);
      } else unsupported('Document refresh', 'meta_refresh', 'Refresh has no supported static URL destination');
    }
    if (element.tagName === 'form' || element.attrs.some((item) => item.name === 'formaction')) unsupported(labelFor(element, 'Form submission'), 'form', 'Forms need explicit field and submission mapping; no form was submitted');
    if (['iframe', 'object', 'embed', 'template'].includes(element.tagName)) unsupported(labelFor(element, `Embedded ${element.tagName} content`), element.tagName, 'Embedded or generated content is not loaded; export its actions explicitly');
    if (element.tagName !== 'script' || !executableScript(element)) continue;
    if (attr(element, 'src')) { unsupported('External script', 'script', 'External scripts are not fetched or executed; export their actions explicitly'); continue; }
    const code = scripts.get(element);
    if (code === undefined) { unsupported('Inline script', 'script', 'Document exceeds the static analysis limit'); continue; }
    const parsed = staticNavigation(code, functions, true);
    if (parsed.destination !== undefined) navigation(parsed.destination, 'Open script redirect destination', 'script', element);
    else if (parsed.reason) unsupported('Inline script', 'script', parsed.reason);
  }
  if (omitted) {
    actions.push({ id: 'html-action-limit', kind: 'unsupported', label: 'Additional document interactions', source: 'document', reason: `${omitted} additional interactions exceed the ${LIMIT}-item inventory limit. Split this report before relying on complete action coverage.` });
    issues.push({ field: 'html.actions', message: 'Action inventory limit reached. Split the document to review every interaction.', severity: 'warning' });
  }
  return actions;
}
