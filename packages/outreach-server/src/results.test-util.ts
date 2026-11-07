import {createEngine,bootstrapWorkspace,authenticate,addPrincipal,registerProviderAccount} from '@splitin/outreach-core';
import {FakeEmailProvider,FakeSocialProvider,FAKE_EMAIL_SECRET,FAKE_SOCIAL_SECRET,staticSecrets} from '@splitin/outreach-fakes';
import {openSqliteDatabase} from '@splitin/outreach-store-sqlite';
/** A server fixture composes only public package interfaces. */
export async function makeResultsEnv(){
 const db=openSqliteDatabase(':memory:');const social=new FakeSocialProvider();const email=new FakeEmailProvider();const now=()=>Date.UTC(2025,2,4,14);
 const engine=createEngine({db,adapters:[email.adapter(),social.adapter()],secrets:staticSecrets({'env:FAKE_EMAIL':FAKE_EMAIL_SECRET,'env:FAKE_SOCIAL':FAKE_SOCIAL_SECRET}),workerId:'results-api',sendGate:{mode:'open'},now});
 bootstrapWorkspace(db,{workspaceId:'ws',name:'Results',adminRef:'test:admin',adminName:'Admin'},now());const admin=authenticate(db,'ws','test:admin','test','admin');
 const role=(name:'viewer'|'operator'|'approver')=>{addPrincipal(engine,admin,{externalRef:'test:'+name,displayName:name,roles:[name]});return authenticate(db,'ws','test:'+name,'test',name);};
 const viewer=role('viewer');const operator=role('operator');const approver=role('approver');
 const accountId=await registerProviderAccount(engine,admin,{provider:'fake-email',externalAccountId:'sender@example.com',sender:{name:'Sender',address:'sender@example.com'},purposes:['automated_outreach'],secretRef:'env:FAKE_EMAIL'});
 return{engine,admin,viewer,operator,approver,social,accountId,now};
}
export type ResultsTestEnv=Awaited<ReturnType<typeof makeResultsEnv>>;
