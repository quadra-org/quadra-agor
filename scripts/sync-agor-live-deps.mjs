#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

// Target packages whose dependencies should stay in sync with workspace sources
const targetManifests = ['packages/agor-live/package.json', 'packages/client/package.json'];

const sourceManifests = [
  'packages/core/package.json',
  'apps/agor-cli/package.json',
  'apps/agor-daemon/package.json',
  'packages/executor/package.json',
];

const skipDeps = new Set(['@agor/core']);
const mode = process.argv.includes('--check') ? 'check' : 'write';

const readJson = (relPath) => JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
const writeJson = (relPath, data) =>
  writeFileSync(resolve(repoRoot, relPath), `${JSON.stringify(data, null, 2)}\n`);

// Aggregate all dependencies from source packages
const aggregated = new Map();
const conflicts = [];

for (const manifest of sourceManifests) {
  const pkg = readJson(manifest);
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (skipDeps.has(dep)) continue;
    const seen = aggregated.get(dep);
    if (seen && seen !== version) {
      conflicts.push({ dep, seen, version, manifest });
    } else if (!seen) {
      aggregated.set(dep, version);
    }
  }
}

if (conflicts.length) {
  console.error('Dependency version conflicts detected while gathering workspace manifests:');
  for (const conflict of conflicts) {
    console.error(
      ` - ${conflict.dep}: saw ${conflict.seen}, ${conflict.manifest} declares ${conflict.version}`
    );
  }
  process.exit(1);
}

// Sync each target manifest
let allInSync = true;
const allUpdates = [];

for (const targetManifest of targetManifests) {
  const target = readJson(targetManifest);
  const targetDeps = { ...(target.dependencies ?? {}) };
  const updates = [];

  // Only check deps that the target already declares (don't add new ones)
  for (const [dep, version] of aggregated) {
    const current = targetDeps[dep];
    if (current !== undefined && current !== version) {
      updates.push({ dep, from: current, to: version });
      if (mode === 'write') {
        targetDeps[dep] = version;
      }
    }
  }

  if (updates.length) {
    allInSync = false;
    allUpdates.push({ targetManifest, updates });

    if (mode === 'write') {
      const sortedDeps = {};
      for (const dep of Object.keys(targetDeps).sort()) {
        sortedDeps[dep] = targetDeps[dep];
      }
      target.dependencies = sortedDeps;
      writeJson(targetManifest, target);
    }
  }
}

if (mode === 'check') {
  if (!allInSync) {
    console.error('Published packages have dependency version mismatches:');
    for (const { targetManifest, updates } of allUpdates) {
      console.error(`\n  ${targetManifest}:`);
      for (const update of updates) {
        console.error(`   - ${update.dep}: expected ${update.to}, found ${update.from ?? '∅'}`);
      }
    }
    console.error('\nRun pnpm sync:agor-live-deps to fix.');
    process.exit(1);
  }
  console.log('All published package dependencies are in sync.');
  process.exit(0);
}

if (allInSync) {
  console.log('All published package dependencies already match workspace manifests.');
  process.exit(0);
}

for (const { targetManifest, updates } of allUpdates) {
  console.log(`Updated ${targetManifest} with ${updates.length} change(s):`);
  for (const update of updates) {
    console.log(` - ${update.dep}: ${update.from ?? '∅'} -> ${update.to}`);
  }
}
