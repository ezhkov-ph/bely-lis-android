"""Build controller. All bulky project data stays on the project-backed ext4 disk."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

PROJECT = Path('/mnt/c/Users/alex/Downloads/Firefox ru')
DISK = Path('/mnt/ru-browser-build')
UPSTREAM = json.loads((PROJECT / 'config/upstream.json').read_text(encoding='utf-8'))
FIXED_SOURCE = DISK / 'firefox-source'
SOURCE = FIXED_SOURCE if FIXED_SOURCE.exists() else DISK / f"firefox-{UPSTREAM['version']}"
LOGS = PROJECT / 'work/linux-build/logs'


def environment():
    env = os.environ.copy()
    for name, folder in [('MOZBUILD_STATE_PATH', 'mozbuild'), ('CARGO_HOME', 'cargo'),
                         ('RUSTUP_HOME', 'rustup'), ('GRADLE_USER_HOME', 'gradle'),
                         ('PIP_CACHE_DIR', 'pip-cache'), ('TMPDIR', 'tmp')]:
        env[name] = str(DISK / folder)
        (DISK / folder).mkdir(exist_ok=True)
    env['PATH'] = str(DISK / 'mozbuild/rustc/bin') + ':' + str(DISK / 'cargo/bin') + ':' + env['PATH']
    env.pop('MOZ_TELEMETRY_REPORTING', None)
    env['MACH_TELEMETRY_NO_SUBMIT'] = '1'
    env['PYTHONUNBUFFERED'] = '1'
    return env


def verify_source():
    if not os.path.ismount(DISK):
        raise RuntimeError('Project build disk is not mounted')
    pin = json.loads((PROJECT / 'config/upstream.json').read_text())
    revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != pin['revision']:
        raise RuntimeError('Wrong source revision')


def logged(command, name, env, cwd=SOURCE):
    LOGS.mkdir(parents=True, exist_ok=True)
    if (LOGS / (name + '.log')).exists():
        shutil.copyfile(LOGS / (name + '.log'), LOGS / (name + '.previous.log'))
    print(f"Starting {name}; log: {LOGS / (name + '.log')}", flush=True)
    with (LOGS / (name + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    print(f'{name}: exit {result.returncode}', flush=True)
    if result.returncode:
        print('\n'.join((LOGS / (name + '.log')).read_text(errors='replace').splitlines()[-45:]))
        raise SystemExit(result.returncode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['inspect', 'inspect-branding', 'export-branding', 'verify-branding', 'release', 'release-ui', 'release-applied', 'apply', 'bootstrap', 'retry-bootstrap', 'android-help', 'android-build', 'rust-build', 'build', 'pipeline', 'collect', 'network', 'logs'])
    args = parser.parse_args()
    if args.stage == 'network':
        for url in ['https://dl.google.com/android/repository/repository2-1.xml', 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/ping']:
            print(url, flush=True)
            subprocess.run(['curl', '-I', '--connect-timeout', '10', '--max-time', '20', url], timeout=25)
        subprocess.run(['ss', '-tnp'])
        print('Installed build state directories:', ', '.join(p.name for p in (DISK / 'mozbuild').iterdir()))
        return
    if args.stage == 'logs':
        stat = os.statvfs(DISK)
        print(f'Linux disk used: {(stat.f_blocks - stat.f_bfree) * stat.f_frsize / 2**30:.2f} GiB')
        processes = subprocess.check_output(['ps', '-eo', 'pid,etime,pcpu,comm,wchan:24'], text=True)
        for line in processes.splitlines():
            if any(name in line for name in ['git', 'python', 'java', 'clang', 'rustc', 'ninja']):
                print(line)
        for name in ['native-checkout', 'bootstrap', 'android-sdk', 'geckoview', 'fenix']:
            path = LOGS / (name + '.log')
            if path.exists():
                print(name + ':')
                print('\n'.join(path.read_text(errors='replace').splitlines()[-8:]))
        return
    verify_source()
    if args.stage == 'export-branding':
        subprocess.run([sys.executable, str(PROJECT / 'scripts/export-branding-sources.py'), str(PROJECT), str(SOURCE)], check=True)
        return
    if args.stage == 'inspect-branding':
        report = PROJECT / 'artifacts/branding-inventory.txt'
        terms = ['Firefox', 'Mozilla', 'Fenix', 'Preview', 'ic_launcher', 'logo']
        roots = [
            'mobile/android/fenix/app/src/main',
            'mobile/android/fenix/app/build.gradle',
            'mobile/android/fenix/app/src',
            'mobile/android/locales',
            'mobile/android/branding',
        ]
        sections = []
        for term in terms:
            result = subprocess.run(
                ['git', 'grep', '-n', '-I', '-i', '-e', term, '--', *roots],
                cwd=SOURCE, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            matches = result.stdout.splitlines()
            sections.append(f'## {term} ({len(matches)} matches)')
            sections.extend(matches)
            sections.append('')
        resource_root = SOURCE / 'mobile/android/fenix/app/src/main/res'
        assets = sorted(
            str(path.relative_to(SOURCE))
            for path in resource_root.rglob('*')
            if path.is_file() and any(term in path.name.lower() for term in ['launcher', 'logo', 'firefox', 'fenix'])
        )
        sections.append(f'## Named image resources ({len(assets)} files)')
        sections.extend(assets)
        sections.append('')
        report.write_text('\n'.join(sections), encoding='utf-8')
        print(f'Branding inventory: {report}')
        print('\n'.join(line for line in sections if line.startswith('## ')))
        return
    if args.stage == 'retry-bootstrap':
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                command = (proc / 'cmdline').read_bytes().split(b'\0')
                if b'./mach' in command and b'bootstrap' in command and (proc / 'cwd').resolve() == SOURCE:
                    pid = int(proc.name)
                    os.kill(pid, signal.SIGINT)
                    for _ in range(30):
                        if not proc.exists():
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError('Previous bootstrap did not stop; will not overlap runs')
            except (FileNotFoundError, ProcessLookupError):
                pass
        args.stage = 'pipeline'
    if args.stage == 'inspect':
        agents = subprocess.check_output(['git', 'ls-files', '*AGENTS.md'], cwd=SOURCE, text=True)
        print('Instruction files:', agents or '(none)')
        paths = ['AGENTS.md', 'python/mozboot/mozboot/debian.py', 'python/mozboot/mozboot/bootstrap.py']
        for path in paths:
            file = SOURCE / path
            if not file.exists():
                continue
            print(path + ':')
            lines = file.read_text().splitlines()
            if path == 'AGENTS.md':
                print('\n'.join(lines))
            else:
                for i, line in enumerate(lines):
                    if any(term in line for term in ['no_system_changes', 'mobile_android', 'COMMON_PACKAGES', 'SYSTEM_PACKAGES']):
                        print('\n'.join(lines[max(0, i-2):i+10]))
        return
    env = environment()
    if args.stage in ('release', 'release-ui', 'release-applied'):
        status = PROJECT / 'artifacts/release-build-status.json'
        status.write_text(json.dumps({'status': 'running', 'stage': 'preflight'}), encoding='utf-8')
        try:
            subprocess.run([sys.executable, str(PROJECT / 'scripts/validate-branding.py')], check=True)
            if args.stage != 'release-applied':
                subprocess.run([sys.executable, str(PROJECT / 'scripts/apply-overlay.py'), str(PROJECT), str(SOURCE)], check=True)
            config = PROJECT / 'config/mozconfig.arm64'
            ndks = sorted((DISK / 'mozbuild').glob('android-ndk-*'))
            sdk = DISK / 'mozbuild/android-sdk-linux'
            java = sorted((DISK / 'mozbuild/jdk').glob('*/bin/java'))[-1]
            contents = config.read_text()
            if ndks:
                contents += f'\nac_add_options --with-android-ndk={ndks[-1]}\n'
            contents += f'ac_add_options --with-android-sdk={sdk}\n'
            (SOURCE / 'mozconfig').write_text(contents)
            env['ANDROID_HOME'] = str(sdk)
            env['JAVA_HOME'] = str(java.parent.parent)
            env['PATH'] = str(java.parent) + ':' + env['PATH']
            subprocess.run([sys.executable, str(PROJECT / 'scripts/ensure-release-key.py'), str(PROJECT), str(java.parent / 'keytool')], check=True, env=env)
            # `release-applied` means only that build-session has already
            # validated and applied the overlay.  Firefox still needs its
            # Android configuration generated by a full GeckoView build
            # before the Fenix Gradle target is a valid mach command.
            if args.stage in ('release', 'release-applied'):
                status.write_text(json.dumps({'status': 'running', 'stage': 'GeckoView'}), encoding='utf-8')
                logged(['./mach', 'build'], 'release-geckoview', env)
            status.write_text(json.dumps({'status': 'running', 'stage': 'Fenix release'}), encoding='utf-8')
            logged(['./mach', 'gradle', 'fenix:assembleRelease', '-PdisableDebugSigning'], 'release-fenix', env)
            status.write_text(json.dumps({'status': 'running', 'stage': 'sign and verify'}), encoding='utf-8')
            subprocess.run([sys.executable, str(PROJECT / 'scripts/collect-release-apk.py')], check=True, env=env)
            status.write_text(json.dumps({'status': 'complete', 'stage': 'done'}), encoding='utf-8')
        except BaseException as error:
            status.write_text(json.dumps({'status': 'failed', 'stage': 'stopped', 'error': str(error)}), encoding='utf-8')
            raise
        return
    if args.stage == 'verify-branding':
        subprocess.run([sys.executable, str(PROJECT / 'scripts/validate-branding.py')], check=True)
        subprocess.run([sys.executable, str(PROJECT / 'scripts/apply-overlay.py'), str(PROJECT), str(SOURCE)], check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(PROJECT / 'test'), '-p', 'test_*.py'], check=True)
        sdk = DISK / 'mozbuild/android-sdk-linux'
        java = sorted((DISK / 'mozbuild/jdk').glob('*/bin/java'))[-1]
        env['ANDROID_HOME'] = str(sdk)
        env['JAVA_HOME'] = str(java.parent.parent)
        env['PATH'] = str(java.parent) + ':' + env['PATH']
        logged(['./mach', 'gradle', 'fenix:compileDebugKotlin'], 'branding-compile', env)
        return
    if args.stage == 'android-help':
        subprocess.run(['./mach', 'python', '--', 'python/mozboot/mozboot/android.py', '--help'], cwd=SOURCE, env=env, check=True)
        print('Bootstrap mozconfig:', (LOGS / 'mozconfig.bootstrap').read_text())
        return
    if args.stage in ['apply', 'pipeline']:
        subprocess.run([sys.executable, str(PROJECT / 'scripts/apply-overlay.py'), str(PROJECT), str(SOURCE)], check=True)
    if args.stage in ['bootstrap', 'pipeline']:
        logged(['./mach', '--no-interactive', 'bootstrap', '--application-choice=GeckoView/Firefox for Android', '--no-system-changes'], 'bootstrap', env)
    if args.stage in ['android-build', 'pipeline']:
        logged(['./mach', 'python', '--', 'python/mozboot/mozboot/android.py', '--no-interactive'], 'android-sdk', env)
    if args.stage in ['rust-build', 'pipeline']:
        logged([str(SOURCE / 'mach'), 'artifact', 'toolchain', '--from-build', 'linux64-rust-android'], 'rust', env, cwd=DISK / 'mozbuild')
    if args.stage in ['build', 'android-build', 'rust-build', 'pipeline']:
        config = PROJECT / 'config/mozconfig.arm64'
        # Preserve the bootstrap-generated configuration for diagnostics.
        current = SOURCE / 'mozconfig'
        if current.exists() and not (LOGS / 'mozconfig.bootstrap').exists():
            shutil.copyfile(current, LOGS / 'mozconfig.bootstrap')
        ndks = sorted((DISK / 'mozbuild').glob('android-ndk-*'))
        sdk = DISK / 'mozbuild/android-sdk-linux'
        jdks = sorted((DISK / 'mozbuild/jdk').glob('*/bin/java'))
        contents = config.read_text()
        if ndks:
            contents += f'\nac_add_options --with-android-ndk={ndks[-1]}\n'
        if sdk.exists():
            contents += f'ac_add_options --with-android-sdk={sdk}\n'
            env['ANDROID_HOME'] = str(sdk)
        if jdks:
            env['JAVA_HOME'] = str(jdks[-1].parent.parent)
            env['PATH'] = str(jdks[-1].parent) + ':' + env['PATH']
        current.write_text(contents)
        logged(['./mach', 'build'], 'geckoview', env)
        logged(['./mach', 'gradle', 'fenix:assembleDebug'], 'fenix', env)
    if args.stage in ['collect', 'build', 'android-build', 'rust-build', 'pipeline']:
        subprocess.run([sys.executable, str(PROJECT / 'scripts/collect-apk.py')], check=True, env=env)


if __name__ == '__main__':
    main()
