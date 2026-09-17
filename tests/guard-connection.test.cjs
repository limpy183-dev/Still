const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');
const guardSource = source.slice(source.indexOf('function guard('), source.indexOf('function finishDemo('));
function client(behavior) {
  let connections = 0, writes = 0;
  const net = { createConnection() {
    const socket = new EventEmitter();
    socket.setEncoding = socket.setTimeout = socket.destroy = () => {};
    socket.write = () => { writes++; behavior(socket, connections, true); };
    const attempt = ++connections;
    queueMicrotask(() => behavior(socket, attempt, false));
    return socket;
  } };
  const context = vm.createContext({ net, setTimeout: callback => queueMicrotask(callback) });
  vm.runInContext(guardSource, context);
  return { call: request => context.guard(request), counts: () => ({ connections, writes }) };
}
test('retry a busy listener before submitting exactly one session request', async () => {
  const guard = client((socket, attempt, sent) => {
    if (sent) socket.emit('data', '{"ok":true}\n');
    else if (attempt < 3) socket.emit('error', Object.assign(new Error('busy'), { code: 'ENOENT' }));
    else socket.emit('connect');
  });
  assert.equal((await guard.call({ command: 'start' })).ok, true);
  assert.deepEqual(guard.counts(), { connections: 3, writes: 1 });
});
test('never replay a request after it has been submitted', async () => {
  const guard = client((socket, attempt, sent) => {
    if (sent) socket.emit('error', Object.assign(new Error('disconnected'), { code: 'ENOENT' }));
    else socket.emit('connect');
  });
  await assert.rejects(guard.call({ command: 'start' }), /disconnected/);
  assert.deepEqual(guard.counts(), { connections: 1, writes: 1 });
});
test('stop retrying an unavailable service', async () => {
  const guard = client(socket => socket.emit('error', Object.assign(new Error('offline'), { code: 'ENOENT' })));
  await assert.rejects(guard.call({ command: 'status' }), /offline/);
  assert.deepEqual(guard.counts(), { connections: 11, writes: 0 });
});
