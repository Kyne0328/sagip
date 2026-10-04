import {spawn} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this script through npm run dev');
const tscCli = resolve(backendRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const tsxCli = resolve(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

await runOnce(process.execPath, [npmCli, 'run', 'build:console']);

const children = [
  spawn(process.execPath, [tscCli, '-p', 'tsconfig.browser.json', '--watch', '--preserveWatchOutput'], {
    cwd: backendRoot,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [tsxCli, 'watch', 'src/devServer.ts'], {
    cwd: backendRoot,
    stdio: 'inherit',
  }),
];

let stopping = false;

for (const child of children) {
  child.on('exit', code => {
    if (stopping) return;
    if (code === 0 || code === null) return;
    stopAll(code);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(0));
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

function runOnce(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: backendRoot,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', code => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}
