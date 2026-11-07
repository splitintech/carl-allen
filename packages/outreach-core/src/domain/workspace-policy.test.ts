import {it,expect} from 'vitest';
import {makeDomainEnv} from './domain.test-util';
import {getWorkspaceExecutionLimits,newPlanPolicy,setWorkspaceExecutionLimits} from './workspace-policy';
import {createPlanAuthorization,planVerdict} from './cloud-plans';
import {enqueueAction} from '../execution/enqueue';
import {decideApproval} from './approvals';
import {loadAction} from '../execution/actions-repo';
it('allows only administrators to change bounded budgets for new frozen plans',async()=>{const f=await makeDomainEnv();try{
 expect(getWorkspaceExecutionLimits(f.engine,f.viewer)).toEqual({accountPerDay:10,channelPerDay:10});expect(()=>setWorkspaceExecutionLimits(f.engine,f.operator,{accountPerDay:20,channelPerDay:20})).toThrow(/admin/);expect(()=>setWorkspaceExecutionLimits(f.engine,f.admin,{accountPerDay:501,channelPerDay:20})).toThrow();
 const policy=newPlanPolicy(f.engine,f.operator,'UTC');const action=enqueueAction(f.engine.db,{workspaceId:'ws',kind:'email.send',providerAccountId:f.accountId,recipient:'peer@example.org',purpose:'automated_outreach',dueAt:f.now()+3600000,payload:{text:'Reviewed',_policy:policy},idempotencyKey:'frozen-policy',awaitingApproval:true},{kind:'principal',id:f.operator.principalId,source:'test',traceId:'budget'},f.now()).action;const auth=createPlanAuthorization(f.engine,f.operator,'budget',[action],{});decideApproval(f.engine,f.approver,{approvalId:auth.authorizationId,operationHash:auth.operationHash,decision:'approved'});
 setWorkspaceExecutionLimits(f.engine,f.admin,{accountPerDay:5,channelPerDay:5});expect(newPlanPolicy(f.engine,f.operator,'UTC').limits.accountPerDay).toBe(5);const current=loadAction(f.engine.db,action.id)!;expect(JSON.parse(current.payload)._policy.limits.accountPerDay).toBe(10);expect(planVerdict(f.engine.db,current,f.now())).toEqual({kind:'pass'});
 }finally{f.engine.db.close();}});
