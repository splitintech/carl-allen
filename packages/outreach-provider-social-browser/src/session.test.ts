import { describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createSocialSession } from './session';

describe('account session concurrency and cancellation', () => {
  it('discards a CDP connection arriving after cancellation and close', async () => {
    let resolveBrowser!: (browser: Browser) => void;
    let opened!: () => void;
    let connectionClosed = 0;
    let pagesOpened = 0;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    const connect = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(() => {
      opened(); return new Promise<Browser>((resolve) => { resolveBrowser = resolve; });
    });
    const session = createSocialSession({ cdpUrl: 'http://127.0.0.1:9222' });
    try {
      const controller = new AbortController();
      const operation = session.withPage(controller.signal, async () => 'must not execute');
      await started; controller.abort(new Error('cancelled connection'));
      await expect(operation).rejects.toThrow('cancelled connection');
      await session.close();
      resolveBrowser({ close: async () => { connectionClosed++; }, contexts: () => [{ newPage: async () => { pagesOpened++; } }] } as unknown as Browser);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(connectionClosed).toBe(1); expect(pagesOpened).toBe(0);
    } finally { connect.mockRestore(); await session.close(); }
  });
  it('serializes operations while allocating independent pages', async () => {
    const pages: Page[] = [];
    let closed = 0;
    const session = createSocialSession({ pageFactory: async () => {
      const page = { close: async () => { closed += 1; }, isClosed: () => false } as unknown as Page;
      pages.push(page); return page;
    } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = session.withPage(new AbortController().signal, async (page) => { entered(); await gate; return page; });
    await started;
    const second = session.withPage(new AbortController().signal, async (page) => page);
    await Promise.resolve();
    expect(pages).toHaveLength(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBe(b); expect(closed).toBe(2);
    await session.close();
  });
  it('cancels a stalled page creation and closes a page arriving after cancellation', async () => {
    let resolvePage!: (page: Page) => void;
    let opened!: () => void;
    let closed = false;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    const session = createSocialSession({ pageFactory: () => { opened(); return new Promise<Page>((resolve) => { resolvePage = resolve; }); } });
    const controller = new AbortController();
    const operation = session.withPage(controller.signal, async () => 'must not execute');
    await started;
    controller.abort(new Error('cancelled page launch'));
    await expect(operation).rejects.toThrow('cancelled page launch');
    resolvePage({ close: async () => { closed = true; } } as unknown as Page);
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(true);
    await session.close();
  });
});
