#!/usr/bin/env node
// Bundle maintained browser modules and local styles into one credential-free HTML artifact.
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'apps/papr/bundle/apps/outreach-console');
const result = await build({ entryPoints: [resolve(app, 'publishing/controller.js')], bundle: true, write: false, format: 'iife', target: ['chrome110'], minify: false, legalComments: 'none' });
let html = readFileSync(resolve(app, 'publishing.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g, (_tag, path) => `<style>${readFileSync(resolve(app, path), 'utf8').replace(/<\/style/gi, '<\\/style')}</style>`);
html = html.replace('<script type="module" src="publishing/controller.js"></script>', `<script>${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
if (/<(?:script|link)\b[^>]*(?:src|href)=/i.test(html)) throw new Error('Standalone HTML still requires external executable assets');
mkdirSync(resolve(root, 'dist'), { recursive: true }); const out = resolve(root, 'dist/publishing-studio.html'); writeFileSync(out, html);
process.stdout.write(`Publishing Studio: ${out} (${Buffer.byteLength(html)} bytes, no external scripts/styles)\n`);
