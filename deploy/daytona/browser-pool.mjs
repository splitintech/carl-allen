import { randomUUID } from 'node:crypto';

/** Bounded profile ownership. Active leases are never evicted; idle profiles retain disk state. */
export class BrowserPool {
  constructor({ limit = 2, start, stop, alive = () => true, now = Date.now, leaseMs = 120000 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2) throw new Error('Browser pool limit must be 1..2');
    Object.assign(this, { limit, start, stop, alive, now, leaseMs });
    this.profiles = new Map(); this.leases = new Map(); this.tail = Promise.resolve();
  }
  async locked(fn) {
    const previous = this.tail; let release; this.tail = new Promise(r => { release = r; });
    await previous; try { return await fn(); } finally { release(); }
  }
  sweep() {
    for (const [id, lease] of this.leases) if (lease.until <= this.now()) this.leases.delete(id);
  }
  busy(key) { return [...this.leases.values()].some(v => v.key === key); }
  async acquire(key, binding) {
    return this.locked(async () => {
      this.sweep(); let entry = this.profiles.get(key);
      if (entry && !this.alive(key)) { await this.stop(key); this.profiles.delete(key); entry = undefined; }
      if (this.busy(key)) throw new Error('Browser connection is busy');
      if (!entry && this.profiles.size >= this.limit) {
        const idle = [...this.profiles].filter(([id]) => !this.busy(id)).sort((a, b) => a[1].used - b[1].used)[0];
        if (!idle) throw new Error('Browser pool is at capacity');
        await this.stop(idle[0]); this.profiles.delete(idle[0]);
      }
      if (!entry) { try { await this.start(key, binding); } catch (error) { await this.stop(key); throw error; } entry = { used: this.now() }; this.profiles.set(key, entry); }
      entry.used = this.now(); const id = randomUUID();
      this.leases.set(id, { key, until: this.now() + this.leaseMs }); return { leaseId: id, connectionId: key };
    });
  }
  renew(id) { const lease = this.leases.get(id); if (!lease || lease.until <= this.now()) throw new Error('Browser lease expired'); lease.until = this.now() + this.leaseMs; }
  release(id) { const lease = this.leases.get(id); if (lease) { const entry = this.profiles.get(lease.key); if (entry) entry.used = this.now(); this.leases.delete(id); } }
  snapshot(keys = []) { this.sweep(); return keys.map(key => ({ connectionId: key, state: this.profiles.has(key) ? (this.alive(key) ? 'active' : 'failed') : 'inactive', leased: this.busy(key) })); }
}
