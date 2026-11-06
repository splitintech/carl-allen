#!/usr/bin/env node
// Local CLI entry; the shared host belongs to the Papr package.
import { startPublishingPreview } from '../apps/papr/preview.mjs';
startPublishingPreview();
