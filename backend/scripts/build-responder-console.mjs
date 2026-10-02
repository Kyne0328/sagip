import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(backendRoot, 'package.json'), 'utf8'),
);
const maplibreVersion = packageJson.dependencies?.['maplibre-gl'];
const pmtilesVersion = packageJson.dependencies?.pmtiles;

if (maplibreVersion !== '6.11.2' || pmtilesVersion !== '4.5.0') {
  throw new Error('Responder map dependency versions must match the reviewed C01a pins');
}

const maplibreDist = dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
const maplibreRoot = dirname(maplibreDist);
const pmtilesDist = dirname(dirname(fileURLToPath(import.meta.resolve('pmtiles'))));
const outputRoot = join(backendRoot, '.generated', 'responder-assets');

const assets = [
  {
    source: join(maplibreDist, 'maplibre-gl.mjs'),
    output: join(`maplibre-gl-${maplibreVersion}`, 'maplibre-gl.mjs'),
  },
  {
    source: join(maplibreDist, 'maplibre-gl-shared.mjs'),
    output: join(`maplibre-gl-${maplibreVersion}`, 'maplibre-gl-shared.mjs'),
  },
  {
    source: join(maplibreDist, 'maplibre-gl-worker.mjs'),
    output: join(`maplibre-gl-${maplibreVersion}`, 'maplibre-gl-worker.mjs'),
  },
  {
    source: join(maplibreDist, 'maplibre-gl.css'),
    output: join(`maplibre-gl-${maplibreVersion}`, 'maplibre-gl.css'),
  },
  {
    source: join(pmtilesDist, 'pmtiles.js'),
    output: join(`pmtiles-${pmtilesVersion}`, 'pmtiles.js'),
  },
];

await rm(outputRoot, {recursive: true, force: true});
await mkdir(outputRoot, {recursive: true});

const manifestAssets = [];
for (const asset of assets) {
  const destination = join(outputRoot, asset.output);
  await mkdir(dirname(destination), {recursive: true});
  const bytes = await readFile(asset.source);
  await writeFile(destination, bytes);
  manifestAssets.push({
    path: asset.output.replaceAll('\\', '/'),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const licenseRoot = join(outputRoot, 'licenses');
await mkdir(licenseRoot, {recursive: true});
await copyFile(
  join(maplibreRoot, 'LICENSE.txt'),
  join(licenseRoot, `maplibre-gl-${maplibreVersion}-LICENSE.txt`),
);
await copyFile(
  join(backendRoot, 'vendor-licenses', 'pmtiles-BSD-3-Clause.txt'),
  join(licenseRoot, `pmtiles-${pmtilesVersion}-LICENSE.txt`),
);

await writeFile(
  join(outputRoot, 'asset-manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      dependencies: {
        maplibreGl: maplibreVersion,
        pmtiles: pmtilesVersion,
      },
      assets: manifestAssets,
    },
    null,
    2,
  ) + '\n',
);

console.log(`Prepared ${manifestAssets.length} responder map assets in ${outputRoot}`);
