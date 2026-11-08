import type { InboxCoverage, InboxPage, SqlDatabase } from '@splitin/outreach-contracts';
export interface InboxCursorState { version:1; providerCursor:string; coverage:InboxCoverage; completedAt:number|null }
export function inboxCursorState(cursor:string|null|undefined):InboxCursorState {
 try{const s=JSON.parse(cursor??'null') as InboxCursorState|null;if(s?.version===1&&typeof s.providerCursor==='string'&&typeof s.coverage?.complete==='boolean')return s;}catch{/* Older opaque provider cursors are continued, but cannot prove coverage. */}
 return{version:1,providerCursor:cursor??'',coverage:{complete:false,reason:'Inbox coverage has not been verified.'},completedAt:null};
}
export function storeInboxPage(db:SqlDatabase,accountId:string,page:InboxPage,now:number):void {
 const old=db.prepare('SELECT cursor FROM inbox_cursors WHERE account_id=?').get<{cursor:string|null}>(accountId);const prior=inboxCursorState(old?.cursor);
 const coverage:InboxCoverage=page.coverage?.complete===true?{complete:true,folders:page.coverage.folders??[]}:{complete:false,folders:page.coverage?.folders??[],reason:page.coverage?.reason??'Native inbox continuation or coverage verification is pending.'};
 const state:InboxCursorState={version:1,providerCursor:page.nextCursor,coverage,completedAt:coverage.complete?now:prior.completedAt};
 db.prepare('INSERT INTO inbox_cursors(account_id,cursor,polled_at,error) VALUES (?,?,?,NULL) ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor,polled_at=excluded.polled_at,error=NULL').run(accountId,JSON.stringify(state),now);
}
export function inboxCoverageVerdict(db:SqlDatabase,accountId:string|null,now:number):{held:boolean;reason:string;complete:boolean;coverageReason:string|null;folders:readonly string[];completedAt:number|null} {
 const row=db.prepare('SELECT cursor,polled_at,error FROM inbox_cursors WHERE account_id=?').get<{cursor:string|null;polled_at:number;error:string|null}>(accountId);const state=inboxCursorState(row?.cursor);
 const reason=!row||row.error||now-row.polled_at>15*60000?'inbox_monitoring_stale':!state.coverage.complete?'inbox_coverage_incomplete':'pass';
 return{held:reason!=='pass',reason,complete:state.coverage.complete,coverageReason:state.coverage.reason??null,folders:state.coverage.folders??[],completedAt:state.completedAt};
}
