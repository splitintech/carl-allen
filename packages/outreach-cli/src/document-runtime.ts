import { chromium, type Browser } from 'playwright';
import { digestCanonical, sha256Hex, type DocumentJobRunner, type DocumentTriggerResult, type HtmlImportAction } from '@splitin/outreach-contracts';
import { buildHtmlDocumentPreview } from '@splitin/outreach-import';
import { readPublicDocument, type PublicDocument } from './document-public-url';

export interface DocumentRuntimeOptions { readonly enabled: boolean; readonly executablePath?: string }
interface DocumentRuntimePorts {
  launch?: () => Promise<Browser>;
  readUrl?: (url: string, signal: AbortSignal) => Promise<PublicDocument>;
}
const meaning = (action: HtmlImportAction) => digestCanonical(action.kind === 'compose_email' ? { kind: action.kind, href: action.href, email: action.email } : action.kind === 'open_url' ? { kind: action.kind, href: action.href } : { kind: action.kind });
const detailOf = (error: unknown) => error instanceof Error ? error.message.slice(0, 1000) : 'The background trigger could not finish.';

/** Browser contexts are ephemeral and have no signed-in provider profile or network access. */
export function createDocumentJobRunner(options: DocumentRuntimeOptions, ports: DocumentRuntimePorts = {}): DocumentJobRunner {
  return {
    async run(input) {
      if (!options.enabled) throw new Error('Background document jobs are disabled on this runtime.');
      if (sha256Hex(input.html) !== input.sourceHash) throw new Error('The saved original document changed. Review and schedule it again.');
      if (!input.actions.length || input.actions.length > 20) throw new Error('Choose between one and twenty supported triggers.');
      const preview = buildHtmlDocumentPreview(input.html); const available = new Map(preview.actions.map((action) => [action.id, action]));
      for (const action of input.actions) {
        if (action.kind === 'unsupported' || !available.has(action.id) || meaning(available.get(action.id)!) !== meaning(action)) throw new Error('A detected trigger changed. Review the file before scheduling it again.');
      }
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]); signal.throwIfAborted();
      const browser = await (ports.launch ?? (() => chromium.launch({ headless: true, ...(options.executablePath ? { executablePath: options.executablePath } : {}), timeout: 15_000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync'] })))();
      const abort = () => { void browser.close().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, permissions: [] });
        await context.route('**/*', (route) => route.abort('blockedbyclient'));
        const original = await context.newPage(); await original.setContent(preview.html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        const results: DocumentTriggerResult[] = [];
        for (const action of input.actions) {
          if (action.kind === 'unsupported') throw new Error('Unsupported trigger reached the runner.');
          try {
            signal.throwIfAborted();
            if (preview.boundActionIds.includes(action.id)) await original.locator(`[data-carl-trigger-id="${action.id}"]`).dispatchEvent('click', {}, { timeout: 3000 });
            if (action.kind === 'compose_email') results.push({ actionId: action.id, kind: action.kind, status: 'completed', draft: { ...action.email }, detail: 'Email draft prepared inside Carl Allen. Nothing was sent.' });
            else {
              const target = await (ports.readUrl ?? readPublicDocument)(action.href, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
              const page = await context.newPage();
              try { await page.setContent(buildHtmlDocumentPreview(target.html).html, { waitUntil: 'domcontentloaded', timeout: 10_000 }); results.push({ actionId: action.id, kind: action.kind, status: 'completed', requestedUrl: action.href, finalUrl: target.finalUrl, httpStatus: target.httpStatus, title: (await page.title()).slice(0, 1000), detail: 'Linked document opened in the isolated background browser.' }); }
              finally { await page.close().catch(() => undefined); }
            }
          } catch (error) {
            results.push(action.kind === 'compose_email' ? { actionId: action.id, kind: action.kind, status: 'failed', draft: { ...action.email }, detail: detailOf(error) } : { actionId: action.id, kind: action.kind, status: 'failed', requestedUrl: action.href, detail: detailOf(error) });
          }
        }
        return { results };
      } finally { signal.removeEventListener('abort', abort); await browser.close().catch(() => undefined); }
    },
  };
}
