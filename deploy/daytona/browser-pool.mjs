import { randomUUID } from 'node:crypto';
/** Serializes process ownership and revocable human desktop access; profiles remain on disk. */
export class BrowserPool {
  constructor({limit=2,start,stop,alive=()=>true,now=Date.now,leaseMs=120000,onHumanStart=async()=>({}),onHumanEnd=async()=>{}}) {
    if(!Number.isInteger(limit)||limit<1||limit>2)throw new Error('Browser pool limit must be 1..2');
    Object.assign(this,{limit,start,stop,alive,now,leaseMs,onHumanStart,onHumanEnd});this.profiles=new Map();this.leases=new Map();this.tail=Promise.resolve();
  }
  async locked(fn){const previous=this.tail;let release;this.tail=new Promise(r=>{release=r;});await previous;try{return await fn();}finally{release();}}
  async end(id,lease){
    // Keep ownership when teardown fails. A later retry may recover; new effects stay blocked.
    if(lease.human)await this.onHumanEnd({leaseId:id,connectionId:lease.key});
    this.leases.delete(id);const entry=this.profiles.get(lease.key);if(entry)entry.used=this.now();
  }
  async expire(){for(const[id,lease]of this.leases)if(lease.until<=this.now()){
    if(!lease.human){await this.stop(lease.key);this.profiles.delete(lease.key);}
    await this.end(id,lease);
  }}
  sweep(){return this.locked(()=>this.expire());}
  busy(key){return [...this.leases.values()].some(lease=>lease.key===key);}
  async acquire(key,binding,{human=false}={}){return this.locked(async()=>{
    await this.expire();
    if([...this.leases.values()].some(lease=>lease.human)||human&&this.leases.size)throw new Error('Browser is busy. Finish the active browser operation before opening private sign-in');
    if(human)for(const id of [...this.profiles.keys()].filter(id=>id!==key)){await this.stop(id);this.profiles.delete(id);}
    let entry=this.profiles.get(key);if(entry&&!this.alive(key)){await this.stop(key);this.profiles.delete(key);entry=undefined;}
    if(this.busy(key))throw new Error('Browser connection is busy');
    if(!entry&&this.profiles.size>=this.limit){const idle=[...this.profiles].filter(([id])=>!this.busy(id)).sort((a,b)=>a[1].used-b[1].used)[0];if(!idle)throw new Error('Browser pool is at capacity');await this.stop(idle[0]);this.profiles.delete(idle[0]);}
    if(!entry){try{await this.start(key,binding);}catch(error){await this.stop(key);throw error;}entry={used:this.now()};this.profiles.set(key,entry);}
    entry.used=this.now();const id=randomUUID();const lease={key,human,until:this.now()+this.leaseMs};this.leases.set(id,lease);
    if(human)try{const view=await this.onHumanStart({leaseId:id,connectionId:key});lease.desktopPath=view?.desktopPath;}catch(error){await this.end(id,lease);throw error;}
    return{leaseId:id,connectionId:key};
  });}
  renew(id){return this.locked(async()=>{await this.expire();const lease=this.leases.get(id);if(!lease)throw new Error('Browser lease expired');lease.until=this.now()+this.leaseMs;});}
  owner(id,{human=false}={}){return this.locked(async()=>{await this.expire();const lease=this.leases.get(id);if(!lease||human&&!lease.human)throw new Error('Browser lease expired or is not a human reservation');return lease.key;});}
  withHuman(id,fn){return this.locked(async()=>{await this.expire();const lease=this.leases.get(id);if(!lease?.human)throw new Error('Human browser lease expired');if(!/^websockify\?token=[a-f0-9]{64}$/.test(lease.desktopPath??''))throw new Error('Private desktop authorization is unavailable');lease.until=this.now()+this.leaseMs;return fn({connectionId:lease.key,desktopPath:lease.desktopPath});});}
  remove(key){return this.locked(async()=>{await this.expire();if(this.busy(key))throw new Error('Browser is reserved; profile retained');if(this.profiles.has(key))await this.stop(key);this.profiles.delete(key);});}
  release(id){return this.locked(async()=>{const lease=this.leases.get(id);if(lease)await this.end(id,lease);});}
  snapshot(keys=[]){return this.locked(async()=>{await this.expire();return keys.map(key=>({connectionId:key,state:this.profiles.has(key)?(this.alive(key)?'active':'failed'):'inactive',leased:this.busy(key)}));});}
  prune(keys){return this.locked(async()=>{await this.expire();const configured=new Set(keys);for(const key of [...this.profiles.keys()])if(!configured.has(key)&&!this.busy(key)){await this.stop(key);this.profiles.delete(key);}});}
}
