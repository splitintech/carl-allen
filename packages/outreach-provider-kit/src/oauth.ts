// Copyright (c) 2026 SplitInTech. MIT. Compatible adapter over the versioned shared helper.
import {loopbackAuthorize as authorize,type LoopbackAuthorizeOptions} from '@splitin/spiderman-oauth-loopback';
export type {LoopbackAuthorizeOptions} from '@splitin/spiderman-oauth-loopback';
export function loopbackAuthorize<T>(options:LoopbackAuthorizeOptions<T>):Promise<T>{return authorize({...options,pageTitle:'Outreach engine',rejectMismatchedState:true});}
