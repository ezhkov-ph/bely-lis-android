"""Verify and export an ARM64 test APK; does not install it on a device."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

PROJECT = Path('/mnt/c/Users/alex/Downloads/Firefox ru')
DISK = Path('/mnt/ru-browser-build')
UPSTREAM = json.loads((PROJECT / 'config/upstream.json').read_text(encoding='utf-8'))
FIXED_SOURCE = DISK / 'firefox-source'
SOURCE = FIXED_SOURCE if FIXED_SOURCE.exists() else DISK / f"firefox-{UPSTREAM['version']}"
OUTPUT = PROJECT / 'artifacts/apk'


def main():
    branding = json.loads((PROJECT / 'config/branding.json').read_text(encoding='utf-8'))
    candidates = list((SOURCE / 'obj-ru-arm64/gradle/build/mobile/android/fenix/app/outputs/apk/debug').glob('*.apk'))
    selected = []
    for apk in candidates:
        with zipfile.ZipFile(apk) as archive:
            if any(name.startswith('lib/arm64-v8a/') for name in archive.namelist()):
                selected.append(apk)
    if len(selected) != 1:
        raise RuntimeError(f'Expected one ARM64 debug APK, found {selected}')
    apk = selected[0]
    sdk = DISK / 'mozbuild/android-sdk-linux'
    signers = sorted(sdk.glob('build-tools/*/apksigner'))
    aapts = sorted(sdk.glob('build-tools/*/aapt'))
    if not signers or not aapts:
        raise RuntimeError('Android verification tools unavailable')
    env = os.environ.copy()
    jdks = list((DISK / 'mozbuild').glob('jdk/**/bin/java'))
    if jdks:
        env['JAVA_HOME'] = str(jdks[0].parent.parent)
        env['PATH'] = str(jdks[0].parent) + ':' + env['PATH']
    signature = subprocess.check_output([str(signers[-1]), 'verify', '--verbose', '--print-certs', str(apk)], env=env, text=True, stderr=subprocess.STDOUT)
    badging = subprocess.check_output([str(aapts[-1]), 'dump', 'badging', str(apk)], env=env, text=True, stderr=subprocess.STDOUT)
    if "package: name='org.example.rubrowser.fenix.debug'" not in badging:
        raise RuntimeError('Unexpected APK applicationId')
    expected_label = "'" + branding['displayName'] + "'"
    labels = [line.split(':', 1)[1] for line in badging.splitlines() if line.startswith('application-label')]
    if not labels or any(label != expected_label for label in labels):
        raise RuntimeError('APK still has old or inconsistent application labels; rebuild before exporting')
    matches = {}
    with zipfile.ZipFile(apk) as archive:
        libraries = {name: archive.read(name) for name in archive.namelist() if name.startswith('lib/arm64-v8a/') and name.endswith('.so')}
        for role in ['root', 'intermediate']:
            pem = (PROJECT / 'work/certificates' / f'{role}.pem').read_text()
            der = base64.b64decode(''.join(line for line in pem.splitlines() if not line.startswith('-----')))
            found = [name for name, data in libraries.items() if der in data]
            if not found:
                raise RuntimeError(f'{role} CA bytes not found in native ARM64 libraries')
            matches[role] = found
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT / f"bely-lis-{UPSTREAM['version']}-arm64-test.apk"
    shutil.copyfile(apk, destination)
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    (OUTPUT / 'SHA256SUMS').write_text(f'{checksum}  {destination.name}\n')
    (OUTPUT / 'signature.txt').write_text(signature)
    (OUTPUT / 'badging.txt').write_text(badging)
    (OUTPUT / 'build-report.json').write_text(json.dumps({
        'upstream': json.loads((PROJECT / 'config/upstream.json').read_text()),
        'displayName': branding['displayName'],
        'apk': destination.name, 'sha256': checksum, 'bytes': destination.stat().st_size,
        'certificateLibraries': matches, 'signatureVerified': True,
        'kind': 'debug-test-only', 'deviceTests': 'not performed',
    }, indent=2) + '\n')
    print(f'Exported verified test APK: {destination}\nSHA-256: {checksum}')


if __name__ == '__main__':
    main()
