'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/commands');

test('data dir matches the contract the apps themselves use', () => {
  assert.strictEqual(c.appDataDir('linux', 'ai-mentat-interviews'),
    '/.hexstack-app/ai-mentat-interviews/data');
  assert.strictEqual(c.appDataDir('darwin', 'x'), '/.hexstack-app/x/data');
  assert.strictEqual(c.appDataDir('windows', 'x', 'C:'), 'C:\\.hexstack-app\\x\\data');
});

test('repo checkout is kept beside the data dir, never inside it', () => {
  const repo = c.appRepoDir('linux', 'app');
  const data = c.appDataDir('linux', 'app');
  assert.strictEqual(repo, '/.hexstack-app/app/repo');
  assert.ok(!repo.startsWith(data), 'a git checkout must not live inside the data dir');
});

test('install clones with submodules (the apps pin the SDK as one)', () => {
  const cmd = c.installCmd('linux', 'app', 'https://github.com/x/y.git');
  assert.match(cmd, /^git clone --recurse-submodules /);
  assert.match(cmd, /'https:\/\/github\.com\/x\/y\.git'/);
  assert.match(cmd, /'\/\.hexstack-app\/app\/repo'/);
});

test('update refreshes submodules too, not just the top-level repo', () => {
  const cmd = c.updateCmd('linux', 'app');
  assert.match(cmd, /git pull --ff-only/);
  assert.match(cmd, /git submodule update --init --recursive/);
});

test('PATH TRAVERSAL: the path builders refuse to escape the apps dir', () => {
  // These are exported functions and uninstallCmd ends in `rm -rf`, so the
  // guard must live in the builder, not only in the caller that validates.
  for (const bad of ['../../etc', '..', '.', 'a/b', 'a\\b', '', null, undefined, 'x\0y']) {
    assert.throws(() => c.appRepoDir('linux', bad), /unsafe app name/,
      `appRepoDir should reject ${JSON.stringify(bad)}`);
    assert.throws(() => c.appDataDir('linux', bad), /unsafe app name/,
      `appDataDir should reject ${JSON.stringify(bad)}`);
    assert.throws(() => c.uninstallCmd('linux', bad), /unsafe app name/,
      `uninstallCmd should reject ${JSON.stringify(bad)}`);
  }
  // and a legitimate name still works
  assert.strictEqual(c.appRepoDir('linux', 'ok-app'), '/.hexstack-app/ok-app/repo');
});

test('CONTROL: without the guard a traversal name WOULD escape', () => {
  // Proves the test above is meaningful: the same interpolation, unguarded,
  // produces a path outside the apps directory.
  const unguarded = `/${c.ROOT_DIR_NAME}/${'../../etc'}/repo`;
  assert.ok(unguarded.includes('/../../'), 'control must demonstrate the escape');
  assert.ok(!c.appRepoDir('linux', 'ok-app').includes('..'), 'guarded path stays clean');
});

test('uninstall only ever targets <root>/<app>/repo', () => {
  const cmd = c.uninstallCmd('linux', 'app');
  assert.strictEqual(cmd, `rm -rf '/.hexstack-app/app/repo'`);
  assert.ok(!/rm -rf '\/'/.test(cmd));
  assert.ok(cmd.includes('/repo'), 'must not delete the data dir');
});

/**
 * Injection tests assert what the SHELL does, not what the string looks like.
 * An earlier version of these tests string-matched the command text, stripped
 * the `'\''` escape sequence first, and then "found" the payload in the
 * harmless remainder — it failed while the code was correct. The shell is the
 * only authority on whether an argument stayed a single token.
 */
const { execSync } = require('child_process');

/** Run a command with the real payload replaced by a side-effect-free probe. */
function tokensOf(shellWord) {
  // printf %s\n prints one line per ARGUMENT: 1 line == the value stayed one token
  const out = execSync(`printf '%s\\n' ${shellWord}`, { shell: '/bin/sh' }).toString();
  return out.replace(/\n$/, '').split('\n');
}

test('SHELL INJECTION: a hostile app name is refused outright', () => {
  // This payload contains '/' so the traversal guard rejects it before any
  // command is built — the strongest possible outcome.
  const evil = "app'; touch /tmp/hexrunner_PWNED; echo '";
  assert.throws(() => c.appRepoDir('linux', evil), /unsafe app name/);
  assert.ok(!require('fs').existsSync('/tmp/hexrunner_PWNED'), 'payload must not execute');
});

test('SHELL INJECTION: a quote-only app name still cannot break out', () => {
  // No slashes, so it passes the traversal guard and must be neutralised by
  // quoting instead. This is the case that proves q() is doing real work.
  const evil = "app';touch /tmp/hexrunner_PWNED3;echo 'x";
  // strip slashes so the name is "safe" but still quote-hostile
  const nameNoSlash = evil.replace(/\//g, '_');
  const dir = c.appRepoDir('linux', nameNoSlash);
  const tokens = tokensOf(c.q(dir));
  assert.strictEqual(tokens.length, 1, `escaped to ${tokens.length} tokens: ${tokens}`);
  assert.strictEqual(tokens[0], dir, 'value must survive verbatim');
  assert.ok(!require('fs').existsSync('/tmp/hexrunner_PWNED3'), 'payload must not execute');
});

test('SHELL INJECTION: a hostile repo url stays one argument', () => {
  const evil = "https://x/y.git' && touch /tmp/hexrunner_PWNED2 && echo '";
  const tokens = tokensOf(c.q(evil));
  assert.strictEqual(tokens.length, 1, `escaped to ${tokens.length} tokens`);
  assert.strictEqual(tokens[0], evil);
  assert.ok(!require('fs').existsSync('/tmp/hexrunner_PWNED2'), 'payload must not execute');
});

test('CONTROL: the same payload UNESCAPED does execute (proves the test can fail)', () => {
  const fs = require('fs');
  try { fs.unlinkSync('/tmp/hexrunner_CONTROL'); } catch {}
  // deliberately NOT escaped - this is what a naive implementation would emit
  execSync(`printf '%s\\n' 'x'; touch /tmp/hexrunner_CONTROL; echo 'y'`, { shell: '/bin/sh' });
  assert.ok(fs.existsSync('/tmp/hexrunner_CONTROL'),
    'if this fails the injection tests prove nothing');
  fs.unlinkSync('/tmp/hexrunner_CONTROL');
});

test('q() escaping round-trips through a real shell', async () => {
  const { execSync } = require('child_process');
  for (const s of ["plain", "with space", "single'quote", "a;b", "$(whoami)", "`id`", '"dq"']) {
    const out = execSync(`printf '%s' ${c.q(s)}`).toString();
    assert.strictEqual(out, s, `escaping failed for ${JSON.stringify(s)}`);
  }
});

test('prereq check reports all three tools and parses back', () => {
  const cmd = c.checkPrereqsCmd('linux');
  for (const t of ['git', 'node', 'npm']) assert.ok(cmd.includes(t), `missing ${t}`);
  const parsed = c.parsePrereqs('git=OK git version 2.43.0\nnode=OK v22.0.0\nnpm=MISSING');
  assert.strictEqual(parsed.git.ok, true);
  assert.strictEqual(parsed.git.version, 'git version 2.43.0');
  assert.strictEqual(parsed.node.ok, true);
  assert.strictEqual(parsed.npm.ok, false);
});

test('prereq check actually works against this machine', () => {
  const { execSync } = require('child_process');
  const out = execSync(c.checkPrereqsCmd('linux'), { shell: '/bin/sh' }).toString();
  const p = c.parsePrereqs(out);
  // git/node must be present here; the point is that the parser reads real output
  assert.ok(typeof p.git.ok === 'boolean' && typeof p.node.ok === 'boolean');
  assert.ok(p.node.ok, 'node runs these tests, so it must report OK');
});

test('run helpers use the required package.json scripts', () => {
  for (const s of ['setup', 'run', 'build', 'check']) {
    assert.match(c.runScriptCmd('linux', '/tmp/app', s), new RegExp(`npm run ${s}$`));
  }
});

test('open dir uses the right opener per platform', () => {
  assert.match(c.openDirCmd('darwin', '/x'), /^open /);
  assert.match(c.openDirCmd('windows', 'C:\\x'), /^explorer /);
  assert.match(c.openDirCmd('linux', '/x'), /^xdg-open /);
});

test('elevate hint names the actual root directory', () => {
  assert.match(c.elevateHint('linux'), /sudo mkdir -p '\/\.hexstack-app'/);
  assert.match(c.elevateHint('windows', 'C:'), /Administrator/);
});
