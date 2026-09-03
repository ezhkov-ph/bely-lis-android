import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certificateRecord, sha256, validateCertificate } from './certdata.mjs';
import { prepareBranding } from './branding.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const upstream = await json('config/upstream.json');
const pins = (await json('config/certificates.json')).certificates;
const sourcePins = await json('config/source-hashes.json');
const brandingPins = await json('config/branding-source-hashes.json');
const branding = await json('config/branding.json');
const russian = await json('config/branding-ru.json');
const logoAssets = await json('config/logo-assets.json');
if (sourcePins.revision !== upstream.revision) throw new Error('Source pins do not match revision');
if (brandingPins.revision !== upstream.revision) throw new Error('Branding pins do not match revision');
for (const [path, hash] of Object.entries(brandingPins.files)) {
  if (sourcePins.files[path] && sourcePins.files[path] !== hash) throw new Error(`Conflicting source hash: ${path}`);
  sourcePins.files[path] = hash;
}
const source = async path => {
  const data = await readFile(resolve(root, 'work/upstream', path));
  if (sha256(data) !== sourcePins.files[path]) throw new Error(`Source hash mismatch: ${path}`);
  return data.toString('utf8');
};
const certificates = await Promise.all(pins.map(async pin => ({ pin, cert: validateCertificate(await readFile(resolve(root, 'work/certificates', pin.file)), pin) })));
const anchor = certificates.find(c => c.pin.role === 'root').cert;
for (const { pin, cert } of certificates) {
  if (pin.role === 'intermediate' && (!cert.checkIssued(anchor) || !cert.verify(anchor.publicKey))) throw new Error('Intermediate signature/issuer mismatch');
}
const certPath = 'security/nss/lib/ckfw/builtins/certdata.txt';
const original = await source(certPath);
if (original.includes('Russian Trusted Root CA')) throw new Error('CA already present; manual review required');
const outputs = new Map([[certPath, original + certificates.map(({ cert, pin }) => certificateRecord(cert, pin)).join('')]]);
const gradlePath = 'mobile/android/fenix/app/build.gradle';
const gradle = await source(gradlePath);
const oldId = 'applicationId "org.mozilla"';
if (gradle.split(oldId).length !== 2) throw new Error('Unexpected applicationId layout');
let brandedGradle = gradle.replace(oldId, 'applicationId "ru.belylis"');
for (const [before, after] of [
  ['applicationIdSuffix ".fenix.debug"', 'applicationIdSuffix ".debug"'],
  ['applicationIdSuffix ".fenix"', 'applicationIdSuffix ".nightly"'],
  ['applicationIdSuffix ".firefox_beta"', 'applicationIdSuffix ".beta"'],
  ['applicationIdSuffix ".firefox"', 'applicationIdSuffix ".browser"'],
  ['"sharedUserId": "org.mozilla.firefox.sharedID"', '"sharedUserId": "ru.belylis.sharedID"'],
  ['def deepLinkSchemeValue = "fenix-nightly"', 'def deepLinkSchemeValue = "belylis-nightly"'],
  ['def deepLinkSchemeValue = "fenix-beta"', 'def deepLinkSchemeValue = "belylis-beta"'],
  ['def deepLinkSchemeValue = "fenix-dev"', 'def deepLinkSchemeValue = "belylis-dev"'],
  ['def deepLinkSchemeValue = "fenix"', 'def deepLinkSchemeValue = "belylis"'],
]) {
  if (!brandedGradle.includes(before)) throw new Error(`Expected Gradle branding token: ${before}`);
  brandedGradle = brandedGradle.replaceAll(before, after);
}
outputs.set(gradlePath, brandedGradle);
const manifestPath = 'mobile/android/fenix/app/src/main/AndroidManifest.xml';
const manifest = await source(manifestPath);
outputs.set(manifestPath, manifest.replaceAll('android:label="@string/app_name"', 'android:label="@string/ru_browser_name"')
  .replace(/android:(icon|roundIcon)="@mipmap\/ic_launcher[^"\s]*"/g, 'android:$1="@mipmap/white_fox_launcher"'));
outputs.set('mobile/android/fenix/app/src/main/res/values/ru_browser.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="ru_browser_name" translatable="false">${branding.displayName}</string>\n    <string name="upstream_firefox_name" translatable="false">Firefox</string>\n</resources>\n`);
for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const asset = `branding/generated/white-fox-launcher-${density}.png`;
  const data = await readFile(resolve(root, asset));
  if (sha256(data) !== logoAssets.files[asset]) throw new Error(`Logo asset hash mismatch: ${asset}`);
  outputs.set(`mobile/android/fenix/app/src/main/res/mipmap-${density}/white_fox_launcher.png`, data);

  const onboardingAsset = `branding/generated/white-fox-onboarding-${density}.png`;
  const onboardingData = await readFile(resolve(root, onboardingAsset));
  if (sha256(onboardingData) !== logoAssets.files[onboardingAsset]) {
    throw new Error(`Onboarding asset hash mismatch: ${onboardingAsset}`);
  }
  outputs.set(
    `mobile/android/fenix/app/src/main/res/drawable-${density}/ic_onboarding_welcome.png`,
    onboardingData,
  );
}
const sharedLogoPath = 'mobile/android/fenix/app/src/main/res/drawable/ic_firefox.xml';
outputs.set(sharedLogoPath, `<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android"
    android:src="@mipmap/white_fox_launcher"
    android:gravity="center"
    android:filter="true"
    android:antialias="true" />
`);
const brandingReport = await prepareBranding({ source, pins: brandingPins, branding, russian, outputs });
const manifestFiles = [];
for (const [path, content] of outputs) {
  const output = resolve(root, 'artifacts/overlay', path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
  const entry = { path, originalSha256: sourcePins.files[path] ?? null, sha256: sha256(content) };
  if (branding.previousOverlaySha256?.[path]) entry.previousSha256 = branding.previousOverlaySha256[path];
  if (path === 'mobile/android/fenix/app/src/main/res/values/ru_browser.xml') entry.previousSha256 = branding.previousTestNameSha256;
  manifestFiles.push(entry);
}
manifestFiles.push({
  path: 'mobile/android/fenix/app/src/main/res/drawable/ru_browser_icon.xml',
  originalSha256: null,
  previousSha256: 'f8932c28b3a35ffb5606f1324591e92ac6a25ec958eb9d8ebdb9f5c8403eb894',
  delete: true,
});
const onboardingSourcePath = 'mobile/android/fenix/app/src/main/res/drawable/ic_onboarding_welcome.xml';
const onboardingSource = await readFile(resolve(root, 'work/upstream', onboardingSourcePath));
manifestFiles.push({
  path: onboardingSourcePath,
  originalSha256: sha256(onboardingSource),
  delete: true,
});
await writeFile(resolve(root, 'artifacts/overlay-manifest.json'), JSON.stringify({ upstream, status: 'text-branding-prepared; APK requires rebuild', files: manifestFiles }, null, 2) + '\n');
await writeFile(resolve(root, 'artifacts/text-branding-report.json'), JSON.stringify(brandingReport, null, 2) + '\n');
await writeFile(resolve(root, 'artifacts/certificate-report.json'), JSON.stringify(certificates.map(({ pin, cert }) => ({ label: pin.label, role: pin.role, sha256: cert.fingerprint256, validFrom: cert.validFrom, validTo: cert.validTo, serverTrustAnchor: pin.role === 'root' })), null, 2) + '\n');
console.log(`Prepared ${outputs.size} overlay files for ${branding.displayName}, based on Firefox Android ${upstream.version}. Existing APK is unchanged; rebuild required.`);
