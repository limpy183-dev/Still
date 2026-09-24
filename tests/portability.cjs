// Launch a copied distribution with fresh data, unusual paths and no developer tools on PATH.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
(async () => {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, "Still portability O'Brien & 100% [Ł李]-"));
  try {
    await fs.cp(path.resolve('release/win-unpacked'), path.join(directory, 'app'), { recursive: true });
    const temp = path.join(directory, 'temp');
    await fs.mkdir(temp);
    const env = { ...process.env, STILL_TEST_EXECUTABLE: path.join(directory, 'app', 'Still.exe'), TEMP: temp, TMP: temp,
      PATH: [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';') };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const test of ['packaged.cjs', 'website-setup.cjs', 'alerts-ui.cjs']) {
      const { stdout, stderr } = await execute(process.execPath, [path.resolve('tests', test)], { env, windowsHide: true, timeout: 180000 });
      process.stdout.write(stdout); process.stderr.write(stderr);
    }
    console.log('PASS: relocated packaged app, fresh temporary data, Unicode/special-character paths and Windows-only PATH.');
  } finally {
    // Only remove the exact temporary directory created above, never a supplied path.
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith('Still portability ')) throw Error('Unexpected test cleanup path');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
