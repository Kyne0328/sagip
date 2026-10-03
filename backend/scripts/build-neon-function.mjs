import {cp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {build} from 'esbuild';

const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(backendRoot, '.generated');
const outputRoot = join(generatedRoot, 'neon-api');
const sourceEntry = join(backendRoot, 'src', 'neon', 'api.ts');
const generatedAssetRoot = join(generatedRoot, 'responder-assets');
const generatedBrowserRoot = join(generatedRoot, 'responder-browser');
const mapDataRoot = join(backendRoot, 'map-data');
const deployedAssetRoot = join(outputRoot, 'responder-assets');

const ESM_CJS_INTEROP_BANNER =
  "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

await assertDirectory(generatedAssetRoot, 'generated responder dependency assets');
await assertDirectory(generatedBrowserRoot, 'generated responder browser assets');
await assertDirectory(mapDataRoot, 'Tagum map data');

await rm(outputRoot, {recursive: true, force: true});
await mkdir(outputRoot, {recursive: true});

const result = await build({
  entryPoints: [sourceEntry],
  bundle: true,
  write: false,
  outfile: 'index.mjs',
  minify: true,
  format: 'esm',
  platform: 'node',
  banner: {js: ESM_CJS_INTEROP_BANNER},
  logLevel: 'silent',
});

const bundle = result.outputFiles?.find(file => file.path.endsWith('index.mjs'));
if (!bundle) {
  throw new Error('Neon API bundle did not produce index.mjs');
}
await writeFile(join(outputRoot, 'index.mjs'), bundle.contents);

await cp(mapDataRoot, join(deployedAssetRoot, 'map-data'), {recursive: true});
await cp(generatedAssetRoot, join(deployedAssetRoot, 'generated'), {recursive: true});
await cp(generatedBrowserRoot, join(deployedAssetRoot, 'browser'), {recursive: true});

const requiredFiles = [
  join(outputRoot, 'index.mjs'),
  join(deployedAssetRoot, 'map-data', 'tagum-manifest.json'),
  join(deployedAssetRoot, 'map-data', 'tagum-protomaps-20261002.pmtiles'),
  join(deployedAssetRoot, 'generated', 'maplibre-gl-6.11.2', 'maplibre-gl.mjs'),
  join(deployedAssetRoot, 'generated', 'pmtiles-4.5.0', 'pmtiles.js'),
  join(deployedAssetRoot, 'browser', 'incidentMap.js'),
  join(deployedAssetRoot, 'browser', 'consoleController.js'),
  join(deployedAssetRoot, 'browser', 'serviceWorker.js'),
];
for (const file of requiredFiles) {
  await readFile(file);
}

const packageBytes = await directoryBytes(outputRoot);
console.log(
  `Prepared Neon API function with responder assets in ${outputRoot} (${packageBytes} bytes before compression)`,
);

async function assertDirectory(path, label) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error();
  } catch {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

async function directoryBytes(path) {
  const {readdir} = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}
