import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConflictError } from '@splitin/outreach-core';
export interface MailboxOAuthDependencies { readonly env?:NodeJS.ProcessEnv;readonly fetch?:typeof fetch;readonly directory?:string }
export function mailboxDirectory(deps:MailboxOAuthDependencies={}) {
  const directory=resolve(deps.directory??deps.env?.OUTREACH_MAILBOX_DIR??process.env.OUTREACH_MAILBOX_DIR??join(homedir(),'.outreach','mailboxes'));
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(lstatSync(directory).isSymbolicLink())throw new ConflictError('Mailbox storage cannot be a symbolic link');
  chmodSync(directory,0o700);return directory;
}
export function mailboxPath(deps:MailboxOAuthDependencies,id:string,suffix='json') {if(!/^[A-Za-z0-9_-]{10,100}$/.test(id)||!['json','upload'].includes(suffix))throw new ConflictError('Invalid private mailbox artifact');return join(mailboxDirectory(deps),`${id}.${suffix}`);}
export function writePrivate(deps:MailboxOAuthDependencies,id:string,value:unknown) {const path=mailboxPath(deps,id);const temporary=`${path}.tmp`;writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(temporary,path);chmodSync(path,0o600);return path;}
export function readPrivate<T>(deps:MailboxOAuthDependencies,id:string):T {const path=mailboxPath(deps,id);const stat=lstatSync(path);if(!stat.isFile()||stat.mode&0o077)throw new ConflictError('Private mailbox file permissions are invalid');return JSON.parse(readFileSync(path,'utf8')) as T;}
export function removePrivate(deps:MailboxOAuthDependencies,id:string,suffix='json'){rmSync(mailboxPath(deps,id,suffix),{force:true});}
export function removeOwnedGrant(deps:MailboxOAuthDependencies,ref:string){if(!ref.startsWith('file:'))return false;const path=resolve(ref.slice(5));if(!path.startsWith(mailboxDirectory(deps)+'/')||!/^grant-[A-Za-z0-9_-]+\.json$/.test(path.split('/').at(-1)??''))return false;rmSync(path,{force:true});return true;}
