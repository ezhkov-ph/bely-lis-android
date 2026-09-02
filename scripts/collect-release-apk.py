"""Align, release-sign, verify and export the production-like ARM64 APK."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

PROJECT = Path('/mnt/c/Users/alex/Downloads/Firefox ru')
DISK = Path('/mnt/ru-browser-build')
UPSTREAM = json.loads((PROJECT / 'config/upstream.json').read_text(encoding='utf-8'))
FIXED_SOURCE = DISK / 'firefox-source'
SOURCE = FIXED_SOURCE if FIXED_SOURCE.exists() else DISK / f"firefox-{UPSTREAM['version']}"
OUTPUT = PROJECT / 'artifacts/apk'


def main():
    branding = json.loads((PROJECT / 'config/branding.json').read_text(encoding='utf-8'))
    secrets = json.loads((PROJECT / '.env.signing.json').read_text(encoding='utf-8'))
    candidates = list((SOURCE / 'obj-ru-arm64/gradle/build/mobile/android/fenix/app/outputs/apk/release').glob('*.apk'))
    selected = []
    for apk in candidates:
        with zipfile.ZipFile(apk) as archive:
            if any(name.startswith('lib/arm64-v8a/') for name in archive.namelist()):
                selected.append(apk)
    if len(selected) != 1:
        raise RuntimeError(f'Expected one ARM64 release APK, found {selected}')
    apk = selected[0]
    sdk = DISK / 'mozbuild/android-sdk-linux'
    signer = sorted(sdk.glob('build-tools/*/apksigner'))[-1]
    aapt = sorted(sdk.glob('build-tools/*/aapt'))[-1]
    zipalign = sorted(sdk.glob('build-tools/*/zipalign'))[-1]
    java = sorted((DISK / 'mozbuild/jdk').glob('*/bin/java'))[-1]
    env = os.environ.copy()
    env['JAVA_HOME'] = str(java.parent.parent)
    env['PATH'] = str(java.parent) + ':' + env['PATH']
    env['WHITE_FOX_STOREPASS'] = secrets['storePassword']
    env['WHITE_FOX_KEYPASS'] = secrets['keyPassword']
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT / f"bely-lis-{UPSTREAM['version']}-arm64-release.apk"
    with tempfile.TemporaryDirectory(dir=OUTPUT) as folder:
        aligned = Path(folder) / 'aligned.apk'
        signed = Path(folder) / 'signed.apk'
        subprocess.run([str(zipalign), '-P', '16', '-f', '4', str(apk), str(aligned)], check=True)
        subprocess.run([
            str(signer), 'sign', '--ks', str(PROJECT / 'keys/white-fox-release.jks'),
            '--ks-key-alias', 'white-fox-release', '--ks-pass', 'env:WHITE_FOX_STOREPASS',
            '--key-pass', 'env:WHITE_FOX_KEYPASS', '--out', str(signed), str(aligned),
        ], check=True, env=env)
        signature = subprocess.check_output([str(signer), 'verify', '--verbose', '--print-certs', str(signed)], env=env, text=True, stderr=subprocess.STDOUT)
        badging = subprocess.check_output([str(aapt), 'dump', 'badging', str(signed)], env=env, text=True, stderr=subprocess.STDOUT)
        if f"package: name='{branding['releaseApplicationId']}'" not in badging:
            raise RuntimeError('Unexpected release applicationId')
        if 'application-debuggable' in badging:
            raise RuntimeError('Release APK is debuggable')
        expected_label = "'" + branding['displayName'] + "'"
        labels = [line.split(':', 1)[1] for line in badging.splitlines() if line.startswith('application-label')]
        if not labels or any(label != expected_label for label in labels):
            raise RuntimeError('Release APK has old or inconsistent application labels')
        matches = {}
        with zipfile.ZipFile(signed) as archive:
            libraries = {name: archive.read(name) for name in archive.namelist() if name.startswith('lib/arm64-v8a/') and name.endswith('.so')}
            for role in ['root', 'intermediate']:
                pem = (PROJECT / 'work/certificates' / f'{role}.pem').read_text()
                der = base64.b64decode(''.join(line for line in pem.splitlines() if not line.startswith('-----')))
                found = [name for name, data in libraries.items() if der in data]
                if not found:
                    raise RuntimeError(f'{role} CA bytes not found in native ARM64 libraries')
                matches[role] = found
        os.replace(signed, destination)
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    (OUTPUT / 'SHA256SUMS.release').write_text(f'{checksum}  {destination.name}\n')
    (OUTPUT / 'signature.release.txt').write_text(signature)
    (OUTPUT / 'badging.release.txt').write_text(badging)
    (OUTPUT / 'build-report.release.json').write_text(json.dumps({
        'upstream': json.loads((PROJECT / 'config/upstream.json').read_text()),
        'displayName': branding['displayName'], 'applicationId': branding['releaseApplicationId'],
        'apk': destination.name, 'sha256': checksum, 'bytes': destination.stat().st_size,
        'certificateLibraries': matches, 'signatureVerified': True, 'debuggable': False,
        'kind': 'locally-release-signed-arm64', 'deviceTests': 'not performed for this rebuilt APK',
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Exported verified release APK: {destination}\nSHA-256: {checksum}')


if __name__ == '__main__':
    main()
