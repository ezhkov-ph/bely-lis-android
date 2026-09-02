"""Create the persistent local release key once without printing its secrets."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

project, keytool = Path(sys.argv[1]), Path(sys.argv[2])
keys = project / 'keys'
keys.mkdir(exist_ok=True)
keystore = keys / 'white-fox-release.jks'
secret_file = project / '.env.signing.json'
if keystore.exists() != secret_file.exists():
    raise SystemExit('Release key and its secret file must either both exist or both be absent')
if keystore.exists():
    print(f'Using existing release key: {keystore}')
    raise SystemExit(0)

passwords = {'storePassword': secrets.token_urlsafe(48), 'keyPassword': secrets.token_urlsafe(48)}
temporary = secret_file.with_suffix('.tmp')
temporary.write_text(json.dumps(passwords) + '\n', encoding='utf-8')
os.chmod(temporary, 0o600)
os.replace(temporary, secret_file)
env = os.environ.copy()
env['WHITE_FOX_STOREPASS'] = passwords['storePassword']
env['WHITE_FOX_KEYPASS'] = passwords['keyPassword']
subprocess.run([
    str(keytool), '-genkeypair', '-keystore', str(keystore), '-alias', 'white-fox-release',
    '-storetype', 'JKS',
    '-keyalg', 'RSA', '-keysize', '4096', '-sigalg', 'SHA256withRSA', '-validity', '10000',
    '-dname', 'CN=White Fox Browser, OU=Release, O=White Fox Project, C=RU',
    '-storepass:env', 'WHITE_FOX_STOREPASS', '-keypass:env', 'WHITE_FOX_KEYPASS',
], check=True, env=env, stdout=subprocess.DEVNULL)
print(f'Created release key: {keystore}')
print(f'Back up both {keystore} and {secret_file}; future updates require the same key.')
