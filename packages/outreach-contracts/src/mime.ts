// Copyright (c) 2026 SplitInTech. MIT. Compatible adapter over the versioned shared transport.
import {randomBytes} from 'node:crypto';
import {buildMime as compose} from '@splitin/spiderman-mail-mime';
import type {ApprovedEmail} from './providers';
export {MimeError} from '@splitin/spiderman-mail-mime';
export const IDEMPOTENCY_HEADER='X-Outreach-Key';
export function buildMime(email:ApprovedEmail,date:Date,boundary=`=_outreach_${randomBytes(12).toString('hex')}`):string{
  return compose(email,date,boundary,{idempotencyHeader:IDEMPOTENCY_HEADER});
}
