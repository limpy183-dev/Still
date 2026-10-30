// Launch a copied distribution with fresh data, unusual paths and no developer tools on PATH.
// The Rust version of the original check: dist\Still is copied into a folder with Unicode and special characters, its
// temporary data (and so the test profile and WebView2 data) lives there too, and the UI checks run against that copy.
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
    await fs.cp(path.resolve(__dirname, '..', 'dist', 'Still'), path.join(directory, 'app'), { recursive: true });
    const temp = path.join(directory, 'temp');
    await fs.mkdir(temp);
    const env = { ...process.env, STILL_EXE: path.join(directory, 'app', 'Still.exe'), TEMP: temp, TMP: temp,
      PATH: [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';') };
    for (const test of ['ui.cjs', 'alerts-ui.cjs']) {
      const { stdout, stderr } = await execute(process.execPath, [path.resolve(__dirname, test)], { env, windowsHide: true, timeout: 300000 });
      process.stdout.write(stdout); process.stderr.write(stderr);
    }
    console.log('PASS: relocated app, fresh temporary data, Unicode/special-character paths and Windows-only PATH.');
  } finally {
    // Only remove the exact temporary directory created above, never a supplied path.
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith('Still portability ')) throw Error('Unexpected test cleanup path');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
