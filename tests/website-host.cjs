const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Still-host-test-'));
  const file = path.join(root, 'state.json');
  await fs.writeFile(file, JSON.stringify({ session: null }));
  const prefs = path.join(root, 'prefs', 'preferences.json');
  const child = spawn(path.resolve('native/bin/WebsitesTests.exe'), ['--host', file, prefs], { windowsHide: true });
  let buffer = Buffer.alloc(0), messages = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const size = buffer.readUInt32LE(); messages.push(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'))); buffer = buffer.subarray(4 + size);
    }
  });
  async function message(count) {
    const until = Date.now() + 5000;
    while (messages.length < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messages.length, count); return messages.at(-1);
  }
  try {
    assert.deepEqual((await message(1)).websites, []);
    const session = { id: 'session', phase: 'active', endsAt: Date.now() + 600000, apps: [{ name: 'YouTube', path: 'website:youtube.com' }], blockScreen: { mode: 'custom', title: 'Focus', image: 'data:image/jpeg;base64,' + 'A'.repeat(90000) } };
    await fs.writeFile(file + '.tmp', JSON.stringify({ session })); await fs.rename(file + '.tmp', file);
    const active = await message(2); assert.deepEqual(active.websites, ['youtube.com']); assert.equal(active.screen.image.length, session.blockScreen.image.length);
    await fs.writeFile(file, JSON.stringify({ session: { ...session, unlockAt: Date.now() + 10000 } }));
    await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(messages.length, 2, 'No duplicate rules for unchanged website configuration');
    await fs.writeFile(file, 'partial'); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(messages.length, 2, 'Unreadable state never releases blocking');
    await fs.writeFile(file + '.tmp', JSON.stringify({ session: null })); await fs.rename(file + '.tmp', file);
    assert.deepEqual((await message(3)).websites, []);
    const websiteLimits = { bedtime: { from: '22:00', to: '07:00' }, sites: [{ domain: 'youtube.com', minutes: 30, bedtime: true }] };
    await fs.writeFile(prefs + '.tmp', JSON.stringify({ todos: [], websiteLimits })); await fs.rename(prefs + '.tmp', prefs);
    assert.deepEqual((await message(4)).limits, websiteLimits);
    child.stdin.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0);
    console.log('Native messaging passed: initial state, atomic saves, large artwork, change-only delivery, corrupt-state retention, release, daily limits and clean exit.');
  } finally {
    if (child.exitCode === null) child.kill();
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('Still-host-test-')) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
run().catch(error => { console.error(error); process.exit(1); });
