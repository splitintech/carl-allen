/* global document, Event */
// Keep unfinished inline forms through refreshes without retaining credentials or persisting browser storage.
const selector='[data-retain-input],input[type="search"]';
const identity=node=>node.tagName+':'+(node.name||node.id||node.getAttribute('aria-label'));
const pending=new Map();let previousView;
export function clearRetainedInput(node){pending.delete(identity(node));delete node.dataset.carlDirty;}
// Capture before a field's handler can replace its own DOM during a refresh.
for(const name of ['input','change'])document.addEventListener(name,event=>{const node=event.target;if(node?.matches?.(selector)&&node.closest('#studio-body')&&!node.disabled&&!node.readOnly){node.dataset.carlDirty='true';pending.set(identity(node),node.value);}},true);
export function replaceStudio(root,content,view){
 if(previousView!==view)pending.clear();else for(const node of root.querySelectorAll(selector))if(node.dataset.carlDirty==='true'&&!node.disabled&&!node.readOnly)pending.set(identity(node),node.value);
 previousView=view;root.replaceChildren(content);
 for(const node of root.querySelectorAll(selector)){
  const key=identity(node);if(!pending.has(key))continue;const value=pending.get(key);
  if(node.disabled||node.readOnly){pending.delete(key);continue;}
  if(node.value===value){node.dataset.carlDirty='true';continue;}
  node.value=value;if(node.value!==value){pending.delete(key);continue;}node.dataset.carlDirty='true';
  if(node.type==='search')node.dispatchEvent(new Event('input',{bubbles:true}));
  if(node.getAttribute('aria-label')==='Mailbox account')node.dispatchEvent(new Event('change',{bubbles:true}));
 }
}
