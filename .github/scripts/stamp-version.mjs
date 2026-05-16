#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const tag = process.argv[2];
if (!tag) {
  console.error('Usage: stamp-version.mjs <tag>  (e.g. v1.0.1)');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`Tag "${tag}" did not produce a valid semver: "${version}"`);
  process.exit(1);
}

function patchJson(path) {
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  obj.version = version;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function patchText(path, pattern, replacement) {
  const before = readFileSync(path, 'utf8');
  const after = before.replace(pattern, replacement);
  if (before === after) {
    console.error(`No version match in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, after);
}

patchJson('package.json');
patchJson('src-tauri/tauri.conf.json');
patchText(
  'src-tauri/Cargo.toml',
  /^version = "[^"]+"/m,
  `version = "${version}"`,
);
patchText(
  'src-tauri/Cargo.lock',
  /(name = "dryerfox"\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);

console.log(`Stamped version ${version} into package.json, tauri.conf.json, Cargo.toml, Cargo.lock`);
