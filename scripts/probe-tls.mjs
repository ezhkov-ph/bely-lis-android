import tls from 'node:tls';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateCertificate } from './certdata.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(resolve(project, 'config/certificates.json'), 'utf8'));
const pin = config.certificates.find(c => c.role === 'root');
const root = await readFile(resolve(project, 'work/certificates/root.pem'), 'utf8');
validateCertificate(Buffer.from(root), pin);
const hosts = ['www.gosuslugi.ru', 'esia.gosuslugi.ru', 'www.sberbank.ru', 'online.sberbank.ru', 'www.vtb.ru', 'alfabank.ru', 'www.nalog.gov.ru'];

function probe(host, additionalRoot) {
  return new Promise(resolveResult => {
    let finished = false;
    let socket;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolveResult({ host, additionalRoot, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), 15000);
    socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true,
      ca: additionalRoot ? [...tls.rootCertificates, root] : tls.rootCertificates,
    });
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      finish({ ok: socket.authorized, protocol: socket.getProtocol(), issuer: peer.issuer?.CN, leafSha256: peer.fingerprint256 });
    });
    socket.once('error', error => finish({ ok: false, error: error.code ?? error.message }));
  });
}

const results = [];
for (const host of hosts) {
  const pair = await Promise.all([probe(host, false), probe(host, true)]);
  results.push(...pair);
  console.log(`${host}: default=${pair[0].ok ? 'OK' : pair[0].error}; added-root=${pair[1].ok ? 'OK' : pair[1].error}`);
}
await mkdir(resolve(project, 'artifacts'), { recursive: true });
await writeFile(resolve(project, 'artifacts/tls-probe.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
  scope: 'Node TLS handshakes from this computer, no HTTP requests or account access; not Firefox/Android runtime validation', results }, null, 2) + '\n');
