import { Brain } from './brain.js';

const brain = new Brain(18);

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    if (type === 'move') result = brain.chooseMove(payload);
    else if (type === 'analyze') result = brain.analyze(payload);
    else if (type === 'ping') result = 'pong';
    else throw new Error('Unknown request ' + type);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
