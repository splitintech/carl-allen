import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { main } from './main';
import { openRuntime } from './runtime';

describe('CLI fake provider credentials', () => {
  it('executes mixed email and social steps with arbitrary supported secret reference names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outreach-fake-mixed-'));
    const dbPath = join(dir, 'fixture.db');
    const env = { OUTREACH_PRINCIPAL: 'fixture:admin', OUTREACH_DB: dbPath, OUTREACH_WORKSPACE: 'fixture' };
    const file = (name: string, value: string) => { const path = join(dir,name); writeFileSync(path,value); return path; };
    const run = async (...args: string[]) => {
      let out = ''; let error = '';
      const code = await main([...args, '--fake', '--json'], { env, write: x => { out += x; }, writeError: x => { error += x; } });
      expect(code, error).toBe(0);
      return JSON.parse(out) as Record<string, unknown>;
    };
    try {
      await run('init');
      const email = await run('account','add','--provider','fake-email','--external-id','mail@example.invalid','--sender-name','Mail','--sender-email','mail@example.invalid','--purposes','automated_outreach','--secret','env:UNRELATED_MAIL_REFERENCE');
      const social = await run('account','add','--provider','fake-social','--external-id','social-owner','--sender-name','Social','--sender-email','social@example.invalid','--purposes','social_publishing,social_messaging','--secret','keychain:arbitrary-context','--execution-placement','daytona-browser');
      await run('jurisdiction','set','--default','allow','--unknown','allow','--signed-off-by','Fixture','--reference','Synthetic fake providers only');
      await run('gate','open','--reason','Synthetic fake provider fixture; no external sender');
      const mapping = await run('profile','add','fixture',file('mapping.json',JSON.stringify({columns:{email:'Email',full_name:'Name'},consent:{basis:'legitimate_interest'}})));
      const preview = await run('import','preview',file('contacts.csv','Name,Email\nSynthetic Person,person@example.invalid\n'),'--profile',mapping.profileId as string);
      await run('import','commit',preview.batchId as string,'--hash',preview.previewHash as string,'--key','fixture-import');
      await run('template','add','mail','--channel','email','--subject','Synthetic fixture','--text-file',file('mail.txt','Synthetic email, never leaves fake provider.'));
      await run('template','add','post','--channel','linkedin','--text-file',file('post.txt','Synthetic post by {{sender_name}}, never leaves fake provider.'));
      const playbook = file('playbook.json', JSON.stringify({apiVersion:'outreach.splitin.net/v1alpha1',kind:'Playbook',metadata:{name:'fake-mixed'},spec:{purpose:'automated_outreach',policy:{approval:'none',unsubscribe:'reply',requirePostalAddress:false,window:{timezone:'UTC',days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],start:'00:00',end:'23:59'}},steps:[{id:'mail',type:'email.send',template:'mail@1'},{id:'post',type:'social.publish',channel:'linkedin',template:'post@1',providerAccountId:social.providerAccountId}]}}));
      const campaign = await run('campaign','create','Mixed','--playbook',playbook,'--account',email.providerAccountId as string);
      const prepared = await run('campaign','prepare',campaign.campaignId as string);
      await run('campaign','activate',campaign.campaignId as string,'--hash',prepared.operationHash as string);
      await run('worker','--once'); await run('worker','--once');
      const db = openSqliteDatabase(dbPath,{migrate:false});
      try {
        expect(db.prepare('SELECT kind,state FROM scheduled_actions ORDER BY created_at,id').all()).toEqual([{kind:'email.send',state:'succeeded'},{kind:'social.publish',state:'succeeded'}]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get()).toEqual({n:2});
      } finally { db.close(); }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });

  it('does not resolve unsupported fake reference schemes or read files', async () => {
    const dir=mkdtempSync(join(tmpdir(),'outreach-fake-refs-'));
    const runtime=await openRuntime({db:join(dir,'fixture.db'),workspace:'fixture',fake:true,json:true});
    try {
      await expect(runtime.engine.exec.secrets.get('file:/this/file/must/not/be/read')).rejects.toThrow(/bad ref/);
      await expect(runtime.engine.exec.secrets.get('https://example.invalid/secret')).rejects.toThrow(/bad ref/);
    } finally { runtime.close(); rmSync(dir,{recursive:true,force:true}); }
  });
});
