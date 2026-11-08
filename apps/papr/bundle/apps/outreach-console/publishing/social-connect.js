/* global setInterval,clearInterval */
import {el,button,modal,field,busy,notify} from './utils.js';
import {platform} from './model.js';
import {api} from './service.js';

export function socialConnect(channel,refresh,account,savedSessionId){
 const p=platform(channel);const m=modal(account?`Reconnect ${p.name}`:`Connect ${p.name}`,'Your private Daytona browser keeps this account signed in so approved work can run while your computer is off.',true);
 let session,timer,inProgress=false,identifiedProfile;const state=el('p',{class:'flow-note',role:'status','aria-live':'polite',text:'Start a private browser session. Sign in on the platform’s own page, including any verification code.'});const area=el('div',{class:'stack'});const errors=el('p',{class:'banner error',role:'alert',hidden:true});
 const stop=()=>{if(timer)clearInterval(timer);timer=null;};
 const check=async()=>{
  if(!session||inProgress)return;inProgress=true;
  try{session=await api('social-login-check',{sessionId:session.id});state.textContent=session.detail||'Signed-in account found. Confirm the identity below.';errors.hidden=true;
   if(session.identity){if(identifiedProfile===session.identity.profileUrl)return;identifiedProfile=session.identity.profileUrl;const identity=session.identity;const name=el('input',{class:'field-control',value:identity.name,maxlength:200});const confirm=button('Confirm this account',()=>busy(confirm,async()=>{stop();try{const result=await api('social-login-confirm',{sessionId:session.id,input:{profileUrl:identity.profileUrl,name:name.value.trim()||identity.name}});session.status='connected';state.textContent='Account connected. Checking the native publishing formats…';area.replaceChildren();try{const resultQ=await api('account-qualify',{accountId:result.accountId});state.textContent=resultQ.qualification.formats.length?'Connected. Available formats: '+resultQ.qualification.formats.join(', '):'Signed in. '+(resultQ.qualification.detail||'Publishing format verification is still needed.');}catch(error){state.textContent='Signed in. Publishing verification needs attention: '+error.message;}await refresh();m.bottom.replaceChildren(button('Done',m.close,'primary'));notify('Browser account identity saved.');}catch(error){timer=setInterval(()=>{void check();},5000);throw error;}}),'primary');area.replaceChildren(el('div',{class:'info-card'},el('span',{class:'badge',text:'Identity detected'}),el('h3',{text:identity.name}),el('p',{text:identity.profileUrl})),field('Account label',name),confirm,button('This is a different account',()=>{identifiedProfile=undefined;stop();area.replaceChildren(el('p',{class:'flow-note',text:'Switch accounts in the private browser, then check again.'}),button('Check again',()=>{void check();}));timer=setInterval(()=>{void check();},5000);},'small'));}
  }catch(error){errors.hidden=false;errors.textContent=error.message;if(/expired|ended|reservation.*lost/i.test(error.message)){stop();savedSessionId=undefined;session=undefined;identifiedProfile=undefined;area.replaceChildren(start);}}
  finally{inProgress=false;}
 };
 const start=button('Start private sign-in',()=>busy(start,async()=>{
  session=savedSessionId?await api('social-login-resume',{sessionId:savedSessionId}):await api('social-login-start',{input:{channel,...(account?{accountId:account.id}:{})}});errors.hidden=true;
  const open=el('a',{class:'button primary',href:session.loginUrl,target:'_blank',rel:'noopener noreferrer',text:'Open private browser'});
  area.replaceChildren(open,el('p',{class:'field-help',text:'Only this account’s browser is reserved. Keep this screen open while you sign in. No passwords or cookies are copied from your computer.'}),button('Check now',()=>{void check();},'small'));
  state.textContent='Waiting for sign-in. This screen checks automatically.';stop();timer=setInterval(()=>{void check();},5000);
 }),'primary');
 area.append(start);if(account?.externalAccountId?.includes('/company/'))m.content.append(el('p',{class:'field-help',text:'Sign in as the administrator for '+account.externalAccountId+'. Publishing remains bound to that company page.'}));m.content.append(state,area,errors);m.bottom.append(button('Finish later',m.close));
 m.dialog.addEventListener('close',()=>{stop();if(session)void api('social-login-pause',{sessionId:session.id}).then(refresh).catch(()=>undefined);});
}
