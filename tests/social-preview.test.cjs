const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const website = path.join(__dirname, '../website');

for (const file of fs.readdirSync(website).filter(file => file.endsWith('.html'))) {
  test(`${file} has complete, static Still preview metadata`, () => {
    const head = fs.readFileSync(path.join(website, file), 'utf8').split('</head>')[0];
    const meta = key => {
      const matches = [...head.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)]
        .filter(match => match[1] === key);
      assert.equal(matches.length, 1, key);
      assert.ok(matches[0][2], key);
      return matches[0][2];
    };
    const route = file === 'index.html' ? 'home' : file.replace('.html', '');
    const canonical = `https://stillfocus.fyi/${route}`;
    assert.equal(meta('og:url'), canonical);
    assert.ok(head.includes(`<link rel="canonical" href="${canonical}">`));
    assert.equal(meta('og:type'), 'website');
    assert.equal(meta('og:site_name'), 'Still');
    assert.equal(meta('twitter:title'), meta('og:title'));
    assert.equal(meta('twitter:description'), meta('og:description'));
    assert.equal(meta('twitter:card'), 'summary');
    assert.equal(meta('og:image'), 'https://stillfocus.fyi/assets/still.png?v=2');
    assert.equal(meta('twitter:image'), meta('og:image'));
    assert.equal(meta('twitter:image:alt'), meta('og:image:alt'));
    assert.equal(meta('og:image:type'), 'image/png');
    const png = fs.readFileSync(path.join(website, new URL(meta('og:image')).pathname));
    assert.equal(Number(meta('og:image:width')), png.readUInt32BE(16));
    assert.equal(Number(meta('og:image:height')), png.readUInt32BE(20));
  });
}
