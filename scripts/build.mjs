// Bundles the recorder into dist/pitwall-recorder.cjs; with --exe also builds a single executable
// (Node SEA) for the platform this runs on: dist/pitwall-recorder.exe on Windows.
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundle = 'dist/pitwall-recorder.cjs';
await build({
  entryPoints: ['src/recorder/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'info',
});

if (process.argv.includes('--exe')) {
  const blob = 'dist/sea-prep.blob';
  const exe = process.platform === 'win32' ? 'dist/pitwall-recorder.exe' : 'dist/pitwall-recorder';
  writeFileSync(
    'dist/sea-config.json',
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });
  copyFileSync(process.execPath, exe);
  execFileSync(
    process.execPath,
    [
      'node_modules/postject/dist/cli.js',
      exe,
      'NODE_SEA_BLOB',
      blob,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      '--overwrite',
    ],
    { stdio: 'inherit' },
  );
  console.log(`built ${exe}`);
}
