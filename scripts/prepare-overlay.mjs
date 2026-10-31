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
const releaseVersion = `${upstream.version}-${upstream.releaseTagSuffix}`;
if (!/^belylis\.\d+$/.test(upstream.releaseTagSuffix)) throw new Error('Invalid release tag suffix');
if (!brandedGradle.includes('output.versionName.set(versionName)')) throw new Error('Version output hook missing');
brandedGradle = brandedGradle.replaceAll('output.versionName.set(versionName)', `output.versionName.set("${releaseVersion}")`);
outputs.set(gradlePath, brandedGradle);

const updaterRelPath = 'mobile/android/fenix/app/src/main/java/ru/belylis/WhiteFoxUpdater.java';
const updaterTemplate = await readFile(resolve(root, 'src/main/java/ru/belylis/WhiteFoxUpdater.java'), 'utf8');
if (updaterTemplate.split('@BELYLIS_VERSION@').length !== 2) throw new Error('Updater version placeholder missing or duplicated');
const updaterContent = updaterTemplate.replace('@BELYLIS_VERSION@', releaseVersion);
outputs.set(updaterRelPath, updaterContent);

const geckoviewPath = 'mobile/shared/components/geckoview/GeckoViewStartup.sys.mjs';
if (sourcePins.files[geckoviewPath]) {
  const gvOriginal = await source(geckoviewPath);
  const hookTarget = 'lazy.ActorManagerParent.addJSProcessActors(JSPROCESSACTORS);';
  const guardCode = `lazy.ActorManagerParent.addJSProcessActors(JSPROCESSACTORS);

          // BelyLis Auto-guard for Russian CA certificates (DeckyWolf port)
          try {
            const RUSSIAN_ROOT_FP = "D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31";
            const RUSSIAN_SUB_FP  = "BBBDE2103E790B999EC62BD03CF625A5A2E7C316E10AFE6A490EEDEAD8B3FD9B";

            function isRussianCert(cert) {
              if (!cert) return false;
              let cn = cert.commonName || "";
              let fp = (cert.sha256Fingerprint || "").replace(/:/g, "").toUpperCase();
              let issuer = cert.issuerCommonName || "";
              return cn === "Russian Trusted Root CA" ||
                     cn === "Russian Trusted Sub CA" ||
                     issuer.includes("Russian Trusted") ||
                     issuer.includes("Ministry of Digital") ||
                     fp === RUSSIAN_ROOT_FP ||
                     fp === RUSSIAN_SUB_FP;
            }

            function isRussianHost(host) {
              if (!host) return false;
              let h = host.toLowerCase().trim();
              let colon = h.indexOf(":");
              if (colon !== -1) h = h.substring(0, colon);
              while (h.endsWith(".")) h = h.substring(0, h.length - 1);
              return h.endsWith(".ru") ||
                     h.endsWith(".su") ||
                     h.endsWith(".xn--p1ai") ||
                     h === "ru" || h === "su" || h === "xn--p1ai";
            }

            let currentCaMode = 1;
            let lastModeCheck = 0;

            function getCaMode() {
              let now = Date.now();
              if (now - lastModeCheck < 1000) {
                return currentCaMode;
              }
              lastModeCheck = now;
              try {
                let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                file.initWithPath("/data/data/ru.belylis.browser/files/belylis_ca_mode.txt");
                if (!file.exists()) {
                  file.initWithPath("/data/user/0/ru.belylis.browser/files/belylis_ca_mode.txt");
                }
                if (file.exists()) {
                  let fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
                  fstream.init(file, -1, 0, 0);
                  let cstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
                  cstream.init(fstream, "UTF-8", 16, 0);
                  let str = {};
                  cstream.readString(16, str);
                  cstream.close();
                  fstream.close();
                  let parsed = parseInt(str.value.trim(), 10);
                  if (!isNaN(parsed) && (parsed === 0 || parsed === 1 || parsed === 2)) {
                    currentCaMode = parsed;
                  }
                }
              } catch (e) {}
              return currentCaMode;
            }

            Services.obs.addObserver(function(subject, topic) {
              try {
                let channel = subject.QueryInterface(Ci.nsIHttpChannel);
                let secInfo = channel.securityInfo;
                if (!secInfo) return;

                let hasRussianCert = false;
                if (secInfo.succeededCertChain?.length) {
                  for (let cert of secInfo.succeededCertChain) {
                    if (isRussianCert(cert)) {
                      hasRussianCert = true;
                      break;
                    }
                  }
                } else if (secInfo.serverCert && isRussianCert(secInfo.serverCert)) {
                  hasRussianCert = true;
                }

                if (hasRussianCert) {
                  let mode = getCaMode();
                  if (mode === 2) {
                    // Mode 2: Applied to all sites
                    return;
                  }
                  if (mode === 0) {
                    // Mode 0: Disabled completely
                    dump("[BelyLis Auto Guard] Blocked Russian CA (mode disabled)\\n");
                    try {
                      console.warn("[BelyLis Auto Guard] Blocked Russian CA (mode disabled)");
                    } catch (e) {}
                    channel.cancel(Cr.NS_ERROR_ABORT);
                    return;
                  }

                  // Mode 1: Applied to Russian sites only (default)
                  let host = "";
                  try {
                    host = (channel.URI && channel.URI.host) ? channel.URI.host : "";
                  } catch (e) {}

                  if (!isRussianHost(host)) {
                    dump("[BelyLis Auto Guard] Blocked Russian CA on non-Russian host: " + host + "\\n");
                    try {
                      console.warn("[BelyLis Auto Guard] Blocked Russian CA on non-Russian host: " + host);
                    } catch (e) {}
                    channel.cancel(Cr.NS_ERROR_ABORT);
                  }
                }
              } catch (e) {}
            }, "http-on-examine-response");
          } catch (e) {
            warn\`Failed to register BelyLis auto guard: \${e}\`;
          }`;
  if (!gvOriginal.includes(hookTarget)) throw new Error('Expected GeckoViewStartup hook target');
  outputs.set(geckoviewPath, gvOriginal.replace(hookTarget, guardCode));
} else { throw new Error('Required GeckoView security input is not pinned'); }
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
  // Compose painterResource can load raster files directly, but not Android's
  // generic <bitmap> XML drawable.  Keep ic_firefox as a real density-aware
  // PNG because upstream uses it from both Views and Compose screens.
  outputs.set(`mobile/android/fenix/app/src/main/res/drawable-${density}/ic_firefox.png`, data);

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
const sharedLogoSource = await readFile(resolve(root, 'work/upstream', sharedLogoPath));
sourcePins.files[sharedLogoPath] = sha256(sharedLogoSource);
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
  path: sharedLogoPath,
  originalSha256: sha256(sharedLogoSource),
  previousSha256: 'de7a197683182fb8154726fb16924c83485cdf9cb8288382d5d9df65828d6608',
  delete: true,
});
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
