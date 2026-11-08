import { ulid } from '@splitin/outreach-contracts';
import type { DomainEnv } from './env';
import { loadAccount } from '../execution/actions-repo';
import { providerContext } from '../execution/invoke';
import type { ActionRow } from '../execution/types';
import { accountLifecycle } from './account-lifecycle';
/** Failed checks also advance the rotation; an old first page cannot monopolize the poll budget. */
export async function pollConnectionAcceptance(env:DomainEnv,deadline=Date.now()+60000):Promise<void> {
 const rows=env.db.prepare("SELECT s.id,s.workspace_id,s.action_ids FROM outreach_sequences s WHERE s.state='active' ORDER BY COALESCE((SELECT MAX(e.at) FROM sequence_events e WHERE e.sequence_id=s.id AND e.kind IN ('connection_status','connection_poll')),0),s.id").all<{id:string;workspace_id:string;action_ids:string}>();let checked=0;
 for(const row of rows){if(checked>=20||Date.now()>deadline)break;
  const ids=JSON.parse(row.action_ids) as string[];const actions=ids.map(id=>env.db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(row.workspace_id,id));const action=actions.find(a=>a&&a.state!=='succeeded');if(!action||action.state!=='scheduled')continue;
  const payload=JSON.parse(action.payload) as {_waitFor?:string;targetUrl?:string};if(payload._waitFor!=='connected'||!payload.targetUrl)continue;
  const cached=env.db.prepare("SELECT at FROM sequence_events WHERE sequence_id=? AND kind='connection_status' ORDER BY at DESC LIMIT 1").get<{at:number}>(row.id);if(cached&&env.now()-cached.at<60000)continue;
  const account=loadAccount(env.db,action.provider_account_id);const adapter=account&&env.adapters.get(account.provider);if(!account||accountLifecycle(env,account.workspace_id,account.id)||!adapter?.social?.connectionStatus)continue;checked++;
  env.db.prepare('INSERT OR IGNORE INTO sequence_events(id,sequence_id,kind,event_key,data,at) VALUES (?,?,?,?,?,?)').run(ulid(env.now()),row.id,'connection_poll',`poll:${Math.floor(env.now()/1000)}`,JSON.stringify({actionId:action.id}),env.now());
  try{const state=await adapter.social.connectionStatus(providerContext(env.exec,account,ulid(env.now()),AbortSignal.timeout(15000)),payload.targetUrl);env.db.prepare('INSERT OR IGNORE INTO sequence_events(id,sequence_id,kind,event_key,data,at) VALUES (?,?,?,?,?,?)').run(ulid(env.now()),row.id,'connection_status',`connection:${Math.floor(env.now()/60000)}`,JSON.stringify({state}),env.now());}catch{/* An unsuccessful read remains held; the next eligible sequence still gets a turn. */}
 }
}
