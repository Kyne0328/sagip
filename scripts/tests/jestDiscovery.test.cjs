const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const projectConfig = require('../../jest.config.js');

test('frontend discovery excludes Node backend suites under a regex-sensitive checkout path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sagip.[checkout]-'));
  const files = ['__tests__/App.test.tsx', 'src/emergency/__tests__/reports.test.ts', 'backend/test/http/server.test.ts'];
  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      writeFileSync(path.join(root, file), 'test("fixture", () => {});');
    }
    const config = {...projectConfig, rootDir: root};
    delete config.preset;
    const output = execFileSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', JSON.stringify(config), '--listTests', '--json', '--runInBand'], {cwd: root, encoding: 'utf8'});
    const discovered = JSON.parse(output).map(file => path.relative(root, file).replaceAll('\\', '/')).sort();
    assert.deepEqual(discovered, ['__tests__/App.test.tsx', 'src/emergency/__tests__/reports.test.ts']);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('sagip.[checkout]-'));
    rmSync(root, {recursive: true, force: true});
  }
});
