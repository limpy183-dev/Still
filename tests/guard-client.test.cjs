const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuardClient } = require('../app/guard-client.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('history revisions retain full snapshots, reset on restart/offline, and support old guards', async () => {
  let value = { history: [{ id: 'one' }], historyRevision: 'instance-one', session: null }, query;
  const client = createGuardClient(async request => { query = request; if (value instanceof Error) throw value; return value; });
  await client.status(); assert.equal(query.historyRevision, undefined);
  value = { historyRevision: 'instance-one', session: { unlockAt: 500 } };
  assert.deepEqual((await client.status()).history, [{ id: 'one' }]);
  assert.equal(query.historyRevision, 'instance-one');
  assert.equal((await client.status()).session.unlockAt, 500);
  value = { history: [{ id: 'two' }], historyRevision: 'instance-two' };
  assert.equal((await client.status()).history[0].id, 'two');
  await client.status(true); assert.equal(query.historyRevision, undefined, 'exports/bootstrap force snapshots');
  value = Error('offline'); await assert.rejects(client.status(), /offline/);
  value = { history: [] }; await client.status(); assert.equal(query.historyRevision, undefined);
  await client.status(); assert.equal(query.historyRevision, undefined, 'old guards always send history');
});

test('concurrent reads share one request, but mutations fence both requests and cache results', async () => {
  const calls = [];
  const client = createGuardClient(request => { const next = deferred(); calls.push({ request, ...next }); return next.promise; });
  const first = client.status(), shared = client.status();
  assert.equal(first, shared); assert.equal(calls.length, 1);
  const mutation = client.mutate({ command: 'end' });
  const during = client.status(); assert.equal(calls.length, 3);
  calls[1].resolve({ history: [], historyRevision: 'new' }); await mutation;
  const after = client.status(); assert.equal(calls.length, 4);
  calls[0].resolve({ history: [{ id: 'stale' }], historyRevision: 'old' }); await first;
  calls[2].resolve({ history: [], historyRevision: 'during' }); await during;
  calls[3].resolve({ history: [{ id: 'current' }], historyRevision: 'new' }); await after;
  const latest = client.status(); assert.equal(calls[4].request.historyRevision, 'new');
  calls[4].resolve({ historyRevision: 'new' }); assert.equal((await latest).history[0].id, 'current');
});

test('failed mutation invalidates history because the service may have applied it', async () => {
  let query;
  const client = createGuardClient(async request => { query = request; if (request.command !== 'status') throw Error('disconnected'); return { history: [], historyRevision: 'one' }; });
  await client.status(); await assert.rejects(client.mutate({ command: 'end' }), /disconnected/);
  await client.status(); assert.equal(query.historyRevision, undefined);
});
