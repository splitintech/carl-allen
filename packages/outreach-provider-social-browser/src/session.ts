import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface SessionOptions {
  readonly userDataDir?: string;
  readonly cdpUrl?: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly launchTimeoutMs?: number;
  /** Test injection is accepted only by fixture runtime configuration. */
  readonly pageFactory?: () => Promise<Page>;
}
export interface SocialSession {
  withPage<T>(signal: AbortSignal, fn: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** One serialized account session. Every operation gets its own page, including CDP health checks. */
export function createSocialSession(options: SessionOptions): SocialSession {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let reconnectPage: Page | null = null;
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;
  const reset = async () => {
    generation += 1;
    const oldBrowser = browser;
    const oldContext = context;
    browser = null;
    context = null;
    reconnectPage = null;
    if (oldBrowser) await oldBrowser.close().catch(() => undefined);
    else if (oldContext) await oldContext.close().catch(() => undefined);
  };
  const open = async (): Promise<Page> => {
    if (options.pageFactory) return options.pageFactory();
    if (browser && !browser.isConnected()) await reset();
    if (!context) {
      const openingGeneration = generation;
      if (options.cdpUrl) {
        const connected = await chromium.connectOverCDP(options.cdpUrl, { timeout: 15_000 });
        if (generation !== openingGeneration) { await connected.close().catch(() => undefined); throw new Error('Browser connection completed after session cancellation'); }
        browser = connected;
        context = browser.contexts()[0] ?? null;
        if (!context) throw new Error('CDP has no persistent default context');
      } else if (options.userDataDir) {
        const launched = await chromium.launchPersistentContext(options.userDataDir, {
          headless: options.headless ?? true,
          timeout: options.launchTimeoutMs ?? 30_000,
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        if (generation !== openingGeneration) { await launched.close().catch(() => undefined); throw new Error('Persistent browser completed after session cancellation'); }
        context = launched;
        context.on('close', () => { if (context === launched) context = null; });
      } else throw new Error('A persistent profile or authenticated CDP endpoint is required');
    }
    return context.newPage();
  };
  return {
    async withPage(signal, fn) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      let page: Page | undefined;
      let preserve = false;
      try {
        signal.throwIfAborted();
        const opening = open();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => { generation += 1; reject(signal.reason ?? new Error('Browser operation cancelled')); };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        void opening.then((latePage) => { if (signal.aborted) return latePage.close().catch(() => undefined); return undefined; }, () => undefined);
        try { page = await Promise.race([opening, aborted]); }
        finally { signal.removeEventListener('abort', onAbort); }
        signal.throwIfAborted();
        const activePage = page;
        const abort = () => { void activePage.close().catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const result = await fn(page);
          if (reconnectPage) await reconnectPage.close().catch(() => undefined);
          reconnectPage = null;
          return result;
        }
        finally { signal.removeEventListener('abort', abort); }
      } catch (error) {
        if (page && !signal.aborted && !page.isClosed()) {
          if (reconnectPage) await reconnectPage.close().catch(() => undefined);
          reconnectPage = page;
          preserve = true;
        }
        if (browser && !browser.isConnected()) await reset();
        throw error;
      } finally {
        if (page && !preserve) await page.close().catch(() => undefined);
        release();
      }
    },
    async close() { await tail; await reset(); },
  };
}
