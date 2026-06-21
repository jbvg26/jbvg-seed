/**
 * skybridge-db.js
 * SkyBridge IndexedDB Layer
 *
 * Replaces localStorage for manifest caching, Ghost queue,
 * and local state. Survives browser restarts. Works offline.
 *
 * Usage:
 *   await SkyBridgeDB.init();
 *   await SkyBridgeDB.setManifest(manifest);
 *   await SkyBridgeDB.getManifest();
 *   await SkyBridgeDB.queueOperation(identity, payload);
 *   await SkyBridgeDB.getQueue();
 *   await SkyBridgeDB.clearQueue();
 */

(function (global) {
  "use strict";

  const DB_NAME    = "skybridge";
  const DB_VERSION = 1;

  const STORES = {
    manifest:  "manifest",   // signed route manifest
    queue:     "queue",      // offline operation queue
    state:     "state",      // local SkyBridge state
    ghost:     "ghost",      // Ghost delta cache
  };

  let _db = null;

  // ── Init ────────────────────────────────────────────────────
  function init() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORES.manifest)) {
          db.createObjectStore(STORES.manifest, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.queue)) {
          const qs = db.createObjectStore(STORES.queue, {
            keyPath: "id", autoIncrement: true
          });
          qs.createIndex("ts", "ts");
          qs.createIndex("identity", "identity");
        }
        if (!db.objectStoreNames.contains(STORES.state)) {
          db.createObjectStore(STORES.state, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.ghost)) {
          const gs = db.createObjectStore(STORES.ghost, { keyPath: "id" });
          gs.createIndex("ts", "ts");
        }
      };

      req.onsuccess = (event) => {
        _db = event.target.result;
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ── Generic helpers ─────────────────────────────────────────
  function _tx(store, mode, fn) {
    return init().then(db => {
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(store, mode);
        const obj = tx.objectStore(store);
        const req = fn(obj);
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror   = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve();
          tx.onerror    = () => reject(tx.error);
        }
      });
    });
  }

  // ── Manifest ────────────────────────────────────────────────
  function setManifest(manifest) {
    return _tx(STORES.manifest, "readwrite", (store) =>
      store.put({ key: "current", manifest, ts: Date.now() })
    );
  }

  function getManifest() {
    return _tx(STORES.manifest, "readonly", (store) =>
      store.get("current")
    ).then(record => record?.manifest || null);
  }

  function clearManifest() {
    return _tx(STORES.manifest, "readwrite", (store) =>
      store.delete("current")
    );
  }

  // ── Queue ────────────────────────────────────────────────────
  // Queues an operation for Ghost replay when Core is unreachable
  function queueOperation(identity, payload, options = {}) {
    return _tx(STORES.queue, "readwrite", (store) =>
      store.add({
        identity,
        payload,
        ts:       Date.now(),
        retries:  0,
        status:   "pending",
        options
      })
    );
  }

  function getQueue() {
    return init().then(db => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORES.queue, "readonly");
        const store = tx.objectStore(STORES.queue);
        const req   = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    });
  }

  function markQueued(id, status) {
    return init().then(db => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORES.queue, "readwrite");
        const store = tx.objectStore(STORES.queue);
        const get   = store.get(id);
        get.onsuccess = () => {
          const record = get.result;
          if (record) {
            record.status = status;
            record.retries++;
            store.put(record);
          }
          resolve();
        };
        get.onerror = () => reject(get.error);
      });
    });
  }

  function clearQueue() {
    return _tx(STORES.queue, "readwrite", (store) => {
      store.clear();
      return null;
    });
  }

  function clearCompleted() {
    return init().then(db => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORES.queue, "readwrite");
        const store = tx.objectStore(STORES.queue);
        const req   = store.getAll();
        req.onsuccess = () => {
          req.result
            .filter(r => r.status === "complete")
            .forEach(r => store.delete(r.id));
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  // ── State ────────────────────────────────────────────────────
  function setState(key, value) {
    return _tx(STORES.state, "readwrite", (store) =>
      store.put({ key, value, ts: Date.now() })
    );
  }

  function getState(key) {
    return _tx(STORES.state, "readonly", (store) =>
      store.get(key)
    ).then(record => record?.value ?? null);
  }

  // ── Ghost delta cache ─────────────────────────────────────────
  function ghostWrite(id, data) {
    return _tx(STORES.ghost, "readwrite", (store) =>
      store.put({ id, data, ts: Date.now() })
    );
  }

  function ghostRead(id) {
    return _tx(STORES.ghost, "readonly", (store) =>
      store.get(id)
    ).then(record => record?.data ?? null);
  }

  function ghostGetAll() {
    return init().then(db => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORES.ghost, "readonly");
        const store = tx.objectStore(STORES.ghost);
        const req   = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    });
  }

  // ── Flush queue to Ghost ──────────────────────────────────────
  async function flushQueueToGhost(ghostUrl) {
    const queue = await getQueue();
    const pending = queue.filter(r => r.status === "pending");

    if (!pending.length) return { flushed: 0 };

    let flushed = 0;
    for (const op of pending) {
      try {
        const res = await fetch(`${ghostUrl}/_cache/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identity: op.identity,
            payload:  op.payload,
            queued_at: op.ts
          })
        });
        if (res.ok) {
          await markQueued(op.id, "complete");
          flushed++;
        }
      } catch (_) {
        // Ghost also unreachable -- leave in queue
      }
    }

    await clearCompleted();
    return { flushed, remaining: pending.length - flushed };
  }

  // ── Export ────────────────────────────────────────────────────
  const SkyBridgeDB = {
    init,
    setManifest, getManifest, clearManifest,
    queueOperation, getQueue, markQueued, clearQueue, clearCompleted,
    setState, getState,
    ghostWrite, ghostRead, ghostGetAll,
    flushQueueToGhost,
    STORES
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SkyBridgeDB;
  } else {
    global.SkyBridgeDB = SkyBridgeDB;
  }

})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
