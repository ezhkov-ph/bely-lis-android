// Downloads public inputs only. Never installs certificates in any trust store.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = JSON.parse(await readFile(resolve(root, 'config/upstream.json'), 'utf8'));
const brandingPins = JSON.parse(await readFile(resolve(root, 'config/branding-source-hashes.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(upstream.revision)) throw new Error('Expected pinned Git revision');
if (brandingPins.revision !== upstream.revision) throw new Error('Branding source revision mismatch');
const inputs = [
  ...[...new Set([...upstream.sourceFiles, ...Object.keys(brandingPins.files)])].map(path => ({
    url: `https://raw.githubusercontent.com/mozilla-firefox/firefox/${upstream.revision}/${path}`,
    path: `work/upstream/${path}`,
  })),
  { url: 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt', path: 'work/certificates/root.pem' },
  { url: 'https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt', path: 'work/certificates/intermediate.pem' },
];
const report = [];
for (const input of inputs) {
  try {
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
    const destination = resolve(root, input.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
    report.push({ ...input, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    console.log(`OK ${input.path} (${data.length} bytes)`);
  } catch (error) {
    report.push({ ...input, error: error.message, cause: error.cause?.code });
    console.error(`FAILED ${input.path}: ${error.message} ${error.cause?.code ?? ''}`);
    process.exitCode = 1;
  }
}
await mkdir(resolve(root, 'work'), { recursive: true });
await writeFile(resolve(root, 'work/download-report.json'), JSON.stringify(report, null, 2) + '\n');
