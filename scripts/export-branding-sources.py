"""Export immutable text-branding inputs from the verified local checkout."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

project, source = map(Path, sys.argv[1:])
upstream = json.loads((project / 'config/upstream.json').read_text())
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if revision != upstream['revision']:
    raise SystemExit('Source revision mismatch')
paths = subprocess.check_output([
    'git', '-C', str(source), 'ls-files', '--',
    'mobile/android/fenix/app/src/*/res/values*/*.xml',
    'mobile/android/android-components/components/*/src/main/res/values*/*.xml',
    'mobile/android/geckoview/src/main/res/values*/*.xml',
    'mobile/android/branding/unofficial/*',
    'mobile/android/fenix/app/src/main/java/org/mozilla/fenix/settings/about/AboutFragment.kt',
    'mobile/android/fenix/app/src/main/java/org/mozilla/fenix/home/ui/Wordmark.kt',
    'mobile/android/fenix/app/src/main/java/org/mozilla/fenix/pbmlock/UnlockPrivateTabsScreen.kt',
    'mobile/android/fenix/app/src/main/java/org/mozilla/fenix/settings/biometric/ui/UnlockScreen.kt',
    'mobile/android/fenix/app/src/main/res/layout/fragment_about.xml',
], text=True).splitlines()
hashes = {}
for path in paths:
    if not path.endswith(('.xml', '.ftl', '.properties', '.sh', '.kt')):
        continue
    data = subprocess.check_output(['git', '-C', str(source), 'show', f'{revision}:{path}'])
    text = data.decode('utf-8')
    visible = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    if not re.search(r'Firefox|Fennec|Fenix|Mozilla|app_name', visible):
        continue
    destination = project / 'work/upstream' / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    hashes[path] = hashlib.sha256(data).hexdigest()
(project / 'config/branding-source-hashes.json').write_text(
    json.dumps({'revision': revision, 'files': hashes}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8',
)
diagnostics = []
for path in [source / 'obj-ru-arm64/config/autoconf.mk', source / 'obj-ru-arm64/config.status']:
    if path.exists():
        diagnostics.extend(line for line in path.read_text(errors='replace').splitlines() if 'BRANDING_DIRECTORY' in line)
diagnostics.append('searchfox-cli: ' + subprocess.getoutput('command -v searchfox-cli'))
(project / 'artifacts/branding-build-context.txt').write_text('\n'.join(diagnostics), encoding='utf-8')
print(f'Exported {len(hashes)} immutable branding inputs from {revision}')
print('\n'.join(diagnostics))
