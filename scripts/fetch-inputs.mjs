// Downloads public inputs only. Never installs certificates in any trust store.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = JSON.parse(await readFile(resolve(root, 'config/upstream.json'), 'utf8'));
const sourcePins = JSON.parse(await readFile(resolve(root, 'config/source-hashes.json'), 'utf8'));
const brandingPins = JSON.parse(await readFile(resolve(root, 'config/branding-source-hashes.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(upstream.revision)) throw new Error('Expected pinned Git revision');
if (sourcePins.revision !== upstream.revision) throw new Error('Source pin revision mismatch');
if (brandingPins.revision !== upstream.revision) throw new Error('Branding source revision mismatch');
const sourceHashes = { ...sourcePins.files, ...brandingPins.files };
for (const [path, hash] of Object.entries(sourcePins.files)) {
  if (brandingPins.files[path] && brandingPins.files[path] !== hash) {
    throw new Error(`Conflicting source hash: ${path}`);
  }
}
const inputs = [
  ...Object.keys(sourceHashes).map(path => ({
    url: `https://raw.githubusercontent.com/mozilla-firefox/firefox/${upstream.revision}/${path}`,
    path: `work/upstream/${path}`,
    sha256: sourceHashes[path],
  })),
  { url: 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt', path: 'work/certificates/root.pem' },
  { url: 'https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt', path: 'work/certificates/intermediate.pem' },
];
const report = [];
for (const input of inputs) {
  try {
    const destination = resolve(root, input.path);
    if (input.sha256) {
      try {
        const local = await readFile(destination);
        const localHash = createHash('sha256').update(local).digest('hex');
        if (localHash === input.sha256) {
          report.push({ ...input, bytes: local.length, sha256: localHash, source: 'local-verified' });
          console.log(`OK ${input.path} (local, ${local.length} bytes)`);
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const response = await fetch(input.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('Input exceeds 4 MiB');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const digest = createHash('sha256').update(data).digest('hex');
    if (input.sha256 && digest !== input.sha256) throw new Error('Downloaded input does not match pinned SHA-256');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
    report.push({ ...input, bytes: data.length, sha256: digest, source: 'downloaded' });
    console.log(`OK ${input.path} (${data.length} bytes)`);
  } catch (error) {
    report.push({ ...input, error: error.message, cause: error.cause?.code });
    console.error(`FAILED ${input.path}: ${error.message} ${error.cause?.code ?? ''}`);
    process.exitCode = 1;
  }
}
await mkdir(resolve(root, 'work'), { recursive: true });
await writeFile(resolve(root, 'work/download-report.json'), JSON.stringify(report, null, 2) + '\n');
