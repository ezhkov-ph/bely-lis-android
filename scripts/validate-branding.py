"""Validate generated resource structure and preservation of unrelated overlay bytes."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

project = Path(__file__).resolve().parents[1]
manifest = json.loads((project / 'artifacts/overlay-manifest.json').read_text(encoding='utf-8'))
branding = json.loads((project / 'config/branding.json').read_text(encoding='utf-8'))
xml_count = 0
for entry in manifest['files']:
    path = entry['path']
    if entry.get('delete'):
        assert entry.get('originalSha256') or entry.get('previousSha256'), path
        continue
    data = (project / 'artifacts/overlay' / path).read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], path
    if not path.endswith('.xml'):
        continue
    root = ET.fromstring(data)
    xml_count += 1
    if root.tag != 'resources':
        continue
    keys = [(element.tag, element.attrib.get('name')) for element in root]
    assert all(count == 1 for count in Counter(keys).values()), f'Duplicate resource: {path}'
    if entry['originalSha256']:
        original = (project / 'work/upstream' / path).read_bytes()
        before = ET.fromstring(original)
        assert keys == [(element.tag, element.attrib.get('name')) for element in before], path
        assert re.findall(rb'<!--.*?-->', original, re.S) == re.findall(rb'<!--.*?-->', data, re.S), f'Changed comments: {path}'
        old = {element.attrib.get('name'): element for element in before}
        for element in root:
            previous = old[element.attrib.get('name')]
            assert element.attrib == previous.attrib, f'Resource attributes changed: {path}'
    if path.endswith('/values/static_strings.xml') and '/fenix/' in path:
        names = {element.attrib.get('name'): element.text for element in root}
        for key in ('app_name', 'firefox', 'app_name_firefox'):
            if key in names:
                assert names[key] == branding['displayName'], (path, key)

cert_path = 'security/nss/lib/ckfw/builtins/certdata.txt'
original_certdata = (project / 'work/upstream' / cert_path).read_bytes()
branded_certdata = (project / 'artifacts/overlay' / cert_path).read_bytes()
assert branded_certdata.startswith(original_certdata), cert_path
assert branded_certdata.count(b'Russian Trusted Root CA') >= 1, cert_path
assert branded_certdata.count(b'Russian Trusted Sub CA') >= 1, cert_path
gradle = (project / 'artifacts/overlay/mobile/android/fenix/app/build.gradle').read_text(encoding='utf-8')
assert 'applicationId "ru.belylis"' in gradle
assert 'applicationId "org.mozilla"' not in gradle
logo = json.loads((project / 'config/logo-assets.json').read_text(encoding='utf-8'))
for path, digest in logo['files'].items():
    assert hashlib.sha256((project / path).read_bytes()).hexdigest() == digest, path
print(f'Validated {xml_count} XML files, unchanged keys/attributes/comments, application names, NSS bytes, pinned logo assets and application ID configuration.')
