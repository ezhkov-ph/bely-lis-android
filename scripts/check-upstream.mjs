import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const productDetails = 'https://product-details.mozilla.org/1.0/mobile_versions.json';
const repository = 'https://github.com/mozilla-firefox/firefox.git';
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : null;

const response = await fetch(productDetails, {
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
  headers: { 'user-agent': 'white-fox-release-check/1' },
});
if (!response.ok) throw new Error(`Mozilla version check failed: HTTP ${response.status}`);
const payload = await response.json();
const version = payload.version;
if (typeof version !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,2}$/.test(version)) {
  throw new Error('Mozilla returned an unexpected stable version');
}
const tag = `FIREFOX-ANDROID_${version.replaceAll('.', '_')}_RELEASE`;
const line = execFileSync(
  'git',
  ['ls-remote', '--refs', repository, `refs/tags/${tag}`],
  { encoding: 'utf8', timeout: 120_000 },
).trim();
const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(FIREFOX-ANDROID_[A-Z0-9_]+_RELEASE)$/);
if (!match || match[2] !== tag) throw new Error(`Upstream tag was not resolved exactly once: ${tag}`);
const candidate = {
  repository,
  revision: match[1],
  tag,
  version,
  verifiedOn: new Date().toISOString().slice(0, 10),
  channel: 'release',
};
const encoded = JSON.stringify(candidate, null, 2) + '\n';
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded);
}
console.log(JSON.stringify(candidate));
