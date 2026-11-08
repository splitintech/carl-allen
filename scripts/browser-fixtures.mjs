#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// Select the browser revision installed by the locked Playwright package. An explicit local
// executable override is useful when qualifying an installed system browser in isolation.
execFileSync(process.execPath, ['scripts/build-publishing.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run',
  'packages/outreach-provider-social-browser/src', 'apps/papr/src/console-chrome.test.ts', 'apps/papr/src/publishing-studio.test.ts', 'apps/papr/src/publishing-integration.test.ts', 'apps/papr/src/cloud-workspace-ui.test.ts', 'apps/papr/src/publishing-upload-resume.test.ts', 'apps/papr/src/publishing-results-ui.test.ts', 'apps/papr/src/import-mapping.test.ts', 'apps/papr/src/reply-playbooks-ui.test.ts', 'apps/papr/src/workspace-management-ui.test.ts', 'apps/papr/src/sidebar-integration.test.ts', 'apps/papr/src/mailbox-ui.test.ts', 'apps/papr/src/manual-inbox-reply.test.ts', 'apps/papr/src/social-connect-ui.test.ts',
  '--maxWorkers=1',
], {
  stdio: 'inherit',
  env: { ...process.env, OUTREACH_BROWSER_FIXTURES: '1', OUTREACH_TEST_CHROME: process.env.OUTREACH_TEST_CHROME ?? chromium.executablePath() },
});
