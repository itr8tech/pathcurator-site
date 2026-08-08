// PathCurator v2 — cross-tab coordinator (P1).
// opfs-sahpool allows exactly ONE connection, so exactly one tab may own the DB.
//  - Web Locks elect a single PRIMARY (holds the lock, owns the worker, sole writer).
//  - FOLLOWER tabs never open the DB; they proxy reads to the primary over BroadcastChannel
//    and render read-only. Writes broadcast a change event so every tab re-queries.
//  - When the primary goes away, the lock frees and the next waiter is promoted (handoff).
const LOCK = 'pathcurator-db-primary';
const CHANNEL = 'pathcurator-db';

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class Coordinator {
  role = 'pending';        // 'primary' | 'follower'
  isPrimary = false;

  #chan = new BroadcastChannel(CHANNEL);
  #onPromote;              // async () => localExec  (open worker+migrate; returns an (op,args)=>result fn)
  #onChange;              // (evt) => void
  #localExec = null;      // set once this tab is primary
  #pendingReads = new Map();
  #releaseLock = null;

  constructor({ onPromote, onChange }) {
    this.#onPromote = onPromote;
    this.#onChange = onChange || (() => {});
    this.#chan.onmessage = (e) => this.#onMessage(e.data);
    addEventListener('pagehide', () => this.#releaseLock && this.#releaseLock(), { once: true });
  }

  async start() {
    if (!('locks' in navigator)) { await this.#promote(); return this.role; } // ancient browser: single tab, be primary

    // Fast path: grab the lock right now if it's free.
    const becamePrimary = await new Promise((resolve) => {
      navigator.locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise((rel) => { this.#releaseLock = rel; }); // hold until pagehide/close
      });
    });
    if (becamePrimary) { await this.#promote(); return this.role; }

    // Otherwise we're a follower; queue for promotion when the current primary releases.
    this.role = 'follower';
    this.isPrimary = false;
    navigator.locks.request(LOCK, { mode: 'exclusive' }, () =>
      new Promise(async (rel) => { this.#releaseLock = rel; await this.#promote(); }));
    return this.role;
  }

  async #promote() {
    this.#localExec = await this.#onPromote(); // open worker + migrations (+ P4: drain capture_outbox)
    this.role = 'primary';
    this.isPrimary = true;
    this.#chan.postMessage({ type: 'primary-up' }); // tell followers to refresh
    this.#onChange({ type: 'promoted' });           // update our own UI (follower->primary)
  }

  // READ ops: run locally if primary, else ask the primary.
  read(op, args) { return this.isPrimary ? this.#localExec(op, args) : this.#proxyRead(op, args); }

  // WRITE ops: primary only; broadcast a change so all tabs re-query.
  async write(op, args, change) {
    if (!this.isPrimary) throw new Error('This tab is read-only — PathCurator is active in another tab.');
    const result = await this.#localExec(op, args);
    if (change) { this.#chan.postMessage({ type: 'change', ...change }); this.#onChange({ ...change, local: true }); }
    return result;
  }

  #proxyRead(op, args) {
    const reqId = uid();
    return new Promise((resolve, reject) => {
      let tries = 0;
      const send = () => this.#chan.postMessage({ type: 'read-req', reqId, op, args });
      const iv = setInterval(() => { if (++tries > 12) fail(new Error('primary tab did not respond')); else send(); }, 600);
      const done = () => { clearInterval(iv); this.#pendingReads.delete(reqId); };
      const ok = (r) => { done(); resolve(r); };
      const fail = (e) => { done(); reject(e); };
      this.#pendingReads.set(reqId, { ok, fail });
      send(); // resent every 600ms until answered — survives the primary still booting
    });
  }

  async #onMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'read-req': {
        if (!this.isPrimary) return; // only the primary serves reads
        try { const result = await this.#localExec(msg.op, msg.args);
          this.#chan.postMessage({ type: 'read-res', reqId: msg.reqId, ok: true, result }); }
        catch (err) { this.#chan.postMessage({ type: 'read-res', reqId: msg.reqId, ok: false, error: String(err?.message || err) }); }
        break;
      }
      case 'read-res': {
        const p = this.#pendingReads.get(msg.reqId);
        if (p) msg.ok ? p.ok(msg.result) : p.fail(new Error(msg.error));
        break;
      }
      case 'change': this.#onChange(msg); break;
      case 'primary-up': this.#onChange({ type: 'primary-up' }); break;
    }
  }
}
