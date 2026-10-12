// Main-thread handle to the AI worker. A running search can't be interrupted by messages,
// so cancel() terminates the worker and starts a fresh one (takes a few ms).
export class AIClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./ai.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      console.error('AI worker error', e.message);
      for (const p of this.pending.values()) p.reject(new Error('AI worker crashed'));
      this.pending.clear();
      this.worker.terminate();
      this.spawn();
    };
  }

  request(type, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  chooseMove(payload) { return this.request('move', payload); }
  analyze(payload) { return this.request('analyze', payload); }

  cancel() {
    if (!this.pending.size) return;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    this.pending.clear();
    this.spawn();
  }
}
