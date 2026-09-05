'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  isRepoUrl, isValidAppName, parseCatalog, parseWired, mergeRegistry, actionsFor,
} = require('../src/registry');

test('accepts the shipped catalogue shape {name: url}', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    'ai-mentat-interviews': 'https://github.com/hexstack-apps/ai-mentat-interviews.git',
    'ai-mentat-sdk': 'https://github.com/hexstack-apps/ai-mentat-sdk.git',
  }));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(apps.length, 2);
  assert.deepStrictEqual(apps.map(a => a.name).sort(),
    ['ai-mentat-interviews', 'ai-mentat-sdk']);
  assert.ok(apps.every(a => a.kind === 'remote' && a.source === 'catalog'));
});

test('also accepts an array of objects (common first guess)', () => {
  const { apps, errors } = parseCatalog(JSON.stringify([
    { name: 'a', url: 'https://github.com/x/a.git' },
  ]));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(apps[0].name, 'a');
});

test('rejects malformed json with a message instead of throwing', () => {
  const { apps, errors } = parseCatalog('{not json');
  assert.strictEqual(apps.length, 0);
  assert.match(errors[0], /not valid JSON/);
});

test('rejects unsafe app names and bad urls, keeping the good entries', () => {
  const { apps, errors } = parseCatalog(JSON.stringify({
    '../escape': 'https://github.com/x/y.git',
    'has space': 'https://github.com/x/y.git',
    'ok-app': 'https://github.com/x/ok.git',
    'bad-url': 'file:///etc/passwd',
    'js-url': 'javascript:alert(1)',
  }));
  assert.deepStrictEqual(apps.map(a => a.name), ['ok-app']);
  assert.strictEqual(errors.length, 4, errors.join(' | '));
});

test('isValidAppName / isRepoUrl guard the trust boundary', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.', '..', 'x'.repeat(101), null]) {
    assert.ok(!isValidAppName(bad), `should reject name ${JSON.stringify(bad)}`);
  }
  assert.ok(isValidAppName('ai-mentat-roblox-studio'));
  for (const bad of ['file:///x', 'javascript:x', 'http://x/y.git', '', null, 'rm -rf /']) {
    assert.ok(!isRepoUrl(bad), `should reject url ${JSON.stringify(bad)}`);
  }
  assert.ok(isRepoUrl('https://github.com/a/b.git'));
  assert.ok(isRepoUrl('git@github.com:a/b.git'));
});

test('wired entries carry either a remote url or a local path', () => {
  const { apps, errors } = parseWired(JSON.stringify({
    remoteApp: { url: 'https://github.com/x/r.git' },
    localApp: { path: '/home/me/dev/myapp' },
    bareString: 'https://github.com/x/b.git',
    broken: { nothing: true },
  }));
  assert.strictEqual(errors.length, 1);
  const byName = Object.fromEntries(apps.map(a => [a.name, a]));
  assert.strictEqual(byName.remoteApp.kind, 'remote');
  assert.strictEqual(byName.localApp.kind, 'local');
  assert.strictEqual(byName.localApp.path, '/home/me/dev/myapp');
  assert.strictEqual(byName.bareString.kind, 'remote');
});

test('empty wired.json is not an error (first run)', () => {
  const { apps, errors } = parseWired('');
  assert.deepStrictEqual(apps, []);
  assert.deepStrictEqual(errors, []);
});

test('user-wired entry overrides a catalogue entry of the same name', () => {
  const cat = parseCatalog(JSON.stringify({ app: 'https://github.com/upstream/app.git' })).apps;
  const wired = parseWired(JSON.stringify({ app: { path: '/my/fork' } })).apps;
  const merged = mergeRegistry(cat, wired);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].kind, 'local');
  assert.strictEqual(merged[0].path, '/my/fork');
});

test('merge is sorted by name so the list does not jump around', () => {
  const cat = parseCatalog(JSON.stringify({
    zebra: 'https://github.com/x/z.git', alpha: 'https://github.com/x/a.git',
  })).apps;
  assert.deepStrictEqual(mergeRegistry(cat, []).map(a => a.name), ['alpha', 'zebra']);
});

test('actions: remote installs then updates/uninstalls; local only unwires', () => {
  const remote = { name: 'r', kind: 'remote', url: 'https://github.com/x/r.git' };
  const local  = { name: 'l', kind: 'local', path: '/tmp/l' };
  assert.deepStrictEqual(actionsFor(remote, false), ['install']);
  assert.deepStrictEqual(actionsFor(remote, true), ['update', 'open', 'uninstall']);
  // a local repo must never offer uninstall - we do not delete the user's dir
  assert.ok(!actionsFor(local, true).includes('uninstall'));
  assert.ok(actionsFor(local, true).includes('unwire'));
});
