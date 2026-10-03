import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {build} from 'esbuild';

const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(backendRoot, '.generated');
const outputRoot = join(generatedRoot, 'neon-api');
const sourceEntry = join(backendRoot, 'src', 'neon', 'api.ts');
const embeddedModule = resolve(backendRoot, 'src', 'responder', 'embeddedAssets.ts');
const generatedAssetRoot = join(generatedRoot, 'responder-assets');
const generatedBrowserRoot = join(generatedRoot, 'responder-browser');
const mapDataRoot = join(backendRoot, 'map-data');

const ESM_CJS_INTEROP_BANNER =
  "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

const browserAsset = fileName => join(generatedBrowserRoot, fileName);
const routeFiles = new Map([
  ['/responder/assets/maplibre-gl-6.11.2/maplibre-gl.mjs', join(generatedAssetRoot, 'maplibre-gl-6.11.2', 'maplibre-gl.mjs')],
  ['/responder/assets/maplibre-gl-6.11.2/maplibre-gl-shared.mjs', join(generatedAssetRoot, 'maplibre-gl-6.11.2', 'maplibre-gl-shared.mjs')],
  ['/responder/assets/maplibre-gl-6.11.2/maplibre-gl-worker.mjs', join(generatedAssetRoot, 'maplibre-gl-6.11.2', 'maplibre-gl-worker.mjs')],
  ['/responder/assets/maplibre-gl-6.11.2/maplibre-gl.css', join(generatedAssetRoot, 'maplibre-gl-6.11.2', 'maplibre-gl.css')],
  ['/responder/assets/pmtiles-4.5.0/pmtiles.js', join(generatedAssetRoot, 'pmtiles-4.5.0', 'pmtiles.js')],
  ['/responder/map/tagum/manifest.json', join(mapDataRoot, 'tagum-manifest.json')],
  ['/responder/map/tagum/tagum-protomaps-20261002.pmtiles', join(mapDataRoot, 'tagum-protomaps-20261002.pmtiles')],
  ['/responder/map/tagum/NOTICE.txt', join(mapDataRoot, 'NOTICE.md')],
  ['/responder/assets/asset-manifest.json', join(generatedAssetRoot, 'asset-manifest.json')],
  ['/responder/assets/offline-package.js', browserAsset('offlinePackage.js')],
  ['/responder/assets/browser/offlinePackage.js', browserAsset('offlinePackage.js')],
  ['/responder/assets/browser/consoleStore.js', browserAsset('consoleStore.js')],
  ['/responder/assets/browser/consoleTypes.js', browserAsset('consoleTypes.js')],
  ['/responder/assets/browser/offlineAccess.js', browserAsset('offlineAccess.js')],
  ['/responder/assets/browser/receiptVerifier.js', browserAsset('receiptVerifier.js')],
  ['/responder/assets/browser/gatewayClient.js', browserAsset('gatewayClient.js')],
  ['/responder/assets/browser/incidentSnapshot.js', browserAsset('incidentSnapshot.js')],
  ['/responder/assets/browser/actionCodec.js', browserAsset('actionCodec.js')],
  ['/responder/assets/browser/actionOutbox.js', browserAsset('actionOutbox.js')],
  ['/responder/assets/browser/incidentMap.js', browserAsset('incidentMap.js')],
  ['/responder/assets/browser/consoleController.js', browserAsset('consoleController.js')],
  ['/responder/service-worker.js', browserAsset('serviceWorker.js')],
]);

const embeddedAssets = {};
let rawAssetBytes = 0;
for (const [route, file] of routeFiles) {
  const bytes = await readFile(file);
  rawAssetBytes += bytes.byteLength;
  embeddedAssets[route] = bytes.toString('base64');
}

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
  plugins: [
    {
      name: 'sagip-embedded-responder-assets',
      setup(buildContext) {
        buildContext.onLoad({filter: /embeddedAssets\.ts$/}, args => {
          if (resolve(args.path) !== embeddedModule) return null;
          return {
            contents:
              'export const BUNDLED_RESPONDER_ASSETS = ' +
              JSON.stringify(embeddedAssets) +
              ';',
            loader: 'js',
          };
        });
      },
    },
  ],
});

const bundle = result.outputFiles?.find(file => file.path.endsWith('index.mjs'));
if (!bundle) {
  throw new Error('Neon API bundle did not produce index.mjs');
}
await writeFile(join(outputRoot, 'index.mjs'), bundle.contents);

console.log(
  'Prepared self-contained Neon API function in ' +
    outputRoot +
    ' (' +
    bundle.contents.byteLength +
    ' bundle bytes; ' +
    rawAssetBytes +
    ' embedded responder asset bytes)',
);
