#!/usr/bin/env python3
"""Explicit Daytona lifecycle. Writes credentials only to owner-only local connection files."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
import ssl
import sys
from pathlib import Path
import stat
import subprocess
import tempfile
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[2]
STATE_DEFAULT = Path.home() / '.config' / 'outreach' / 'daytona-connection.json'


def private_write(path: Path, value: dict) -> None:
    path = path.expanduser().absolute()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError('Connection file cannot be a symlink')
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        os.chmod(tmp, 0o600)
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def private_read(path: Path) -> dict:
    path = path.expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Connection file must be an owner-only regular file')
    if hasattr(os, 'getuid') and info.st_uid != os.getuid():
        raise ValueError('Connection file must belong to the current user')
    return json.loads(path.read_text())


def create_spec(snapshot: str, name: str) -> dict:
    if not snapshot or not name:
        raise ValueError('Explicit immutable snapshot identity and sandbox name required')
    return dict(snapshot=snapshot, name=name, os_user='root', public=False, auto_stop_interval=0,
                auto_pause_interval=0, auto_delete_interval=-1,
                labels={'app': 'outreach', 'runtime': 'signed-in-browser', 'storage': 'sandbox-disk'})


def run_remote(sandbox: Any, command: str, **kwargs: Any) -> str:
    response = sandbox.process.exec(command, **kwargs)
    if response.exit_code != 0:
        # Provider output may contain credentials or personal data; do not expose it in exceptions.
        raise RuntimeError('Remote outreach command failed; inspect the private sandbox service logs')
    return response.result


def bootstrap(sandbox: Any, workspace: str, timeout: float = 90) -> None:
    sandbox.set_public(False)
    sandbox.set_autostop_interval(0)
    sandbox.set_auto_delete_interval(-1)
    # Container class may not support pausing; disable only where configured.
    if getattr(sandbox, 'auto_pause_interval', None):
        sandbox.set_auto_pause_interval(0)
    run_remote(sandbox, 'node deploy/daytona/bootstrap.mjs', cwd='/opt/outreach',
               env={'DAYTONA_SANDBOX_ID': sandbox.id, 'OUTREACH_WORKSPACE': workspace}, timeout=30)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        check = sandbox.process.exec('node deploy/daytona/healthcheck.mjs', cwd='/opt/outreach', timeout=10)
        if check.exit_code == 0:
            return
        time.sleep(1)
    raise TimeoutError('Outreach readiness failed; sandbox ID was saved for recovery, no replacement created')


def live_view_url(base: str) -> str:
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password:
        raise ValueError('Live view requires a private HTTPS preview URL')
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k not in ('autoconnect', 'resize')]
    query.extend([('autoconnect', 'true'), ('resize', 'scale')])
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '/vnc.html', urlencode(query), ''))


def token_expiry_ms(token: dict) -> float:
    try:
        expires = datetime.fromisoformat(token['expiresAt'].replace('Z', '+00:00'))
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires.timestamp() * 1000
    except (KeyError, TypeError, ValueError, AttributeError):
        return 0


def refresh_connection(sandbox: Any, state: dict, *, signed_seconds: int = 3600) -> dict:
    api = sandbox.get_preview_link(8787)
    live = sandbox.create_signed_preview_url(6080, expires_in_seconds=signed_seconds)
    token_text = run_remote(sandbox, 'cat /data/outreach/console-token.json', timeout=10)
    token = json.loads(token_text)
    if token_expiry_ms(token) <= time.time() * 1000 + 86_400_000:
        # The in-sandbox monitor normally rotates ahead of expiry. Reconnect a
        # stopped/failed supervisor before copying any stale credential to Papr.
        bootstrap(sandbox, state.get('workspace', 'default'))
        for _ in range(10):
            token = json.loads(run_remote(sandbox, 'cat /data/outreach/console-token.json', timeout=10))
            if token_expiry_ms(token) > time.time() * 1000 + 86_400_000:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Console credential renewal did not complete; previous local connection was preserved')
    return {**state, 'sandboxId': sandbox.id, 'apiUrl': api.url,
            'previewToken': api.token, 'apiToken': token['token'],
            'apiTokenExpiresAt': token.get('expiresAt'),
            'apiTokenRole': token.get('role'),
            'liveViewUrl': live_view_url(live.url),
            'expiresAt': int(time.time() * 1000) + signed_seconds * 1000,
            'updatedAt': int(time.time() * 1000)}


def ensure_runtime(client: Any, path: Path, *, snapshot: str | None, name: str,
                   workspace: str, create: bool, params_factory: Any) -> dict:
    if path.exists():
        state = private_read(path)
        if create:
            raise ValueError('State already exists; use reconnect to reuse its sandbox ID')
        sandbox = client.get(state['sandboxId'])
        if (getattr(sandbox, 'labels', {}) or {}).get('app') != 'outreach':
            raise ValueError('Saved sandbox does not carry the outreach ownership label')
        if str(sandbox.state).lower().split('.')[-1] not in ('started', 'running'):
            sandbox.start(timeout=90)
    else:
        if not create:
            raise ValueError('No saved sandbox ID; explicit create is required')
        sandbox = client.create(params_factory(**create_spec(snapshot or '', name)), timeout=300)
        state = {'sandboxId': sandbox.id, 'snapshot': snapshot, 'workspace': workspace}
        # Persist immediately: readiness failure must never cause an untracked second sandbox.
        private_write(path, state)
    bootstrap(sandbox, state.get('workspace', workspace))
    state = refresh_connection(sandbox, state)
    private_write(path, state)
    return {'sandboxId': sandbox.id, 'ready': True, 'connectionFile': str(path),
            'note': 'Use OUTREACH_CONNECTION_FILE on the trusted Papr backend; credentials were not printed.'}


def cli_sdk_config(path: Path) -> dict:
    """Read only the selected owner-only CLI profile, with no credential output."""
    data = private_read(path)
    active = next((p for p in data.get('profiles', []) if p.get('id') == data.get('activeProfile')), None)
    if not active:
        raise ValueError('Daytona CLI has no active authenticated profile')
    api = active.get('api', {})
    if api.get('key'):
        return {'api_url': api['url'], 'api_key': api['key']}
    token = api.get('token') or {}
    if not token.get('accessToken') or not active.get('activeOrganizationId'):
        raise ValueError('Daytona CLI login and organization selection are required')
    return {'api_url': api['url'], 'jwt_token': token['accessToken'], 'organization_id': active['activeOrganizationId']}


def ensure_default_ca() -> None:
    """Supply a verified CA bundle only when Python has no effective default trust."""
    if 'SSL_CERT_FILE' in os.environ or 'SSL_CERT_DIR' in os.environ:
        return
    paths = ssl.get_default_verify_paths()
    # A capath may load roots lazily, so preserve it even if the store is empty.
    if paths.cafile or paths.capath:
        return
    if ssl.create_default_context().cert_store_stats()['x509_ca']:
        return
    # certifi is supplied by the pinned SDK dependencies. Never disable verification.
    import certifi
    os.environ['SSL_CERT_FILE'] = certifi.where()


def sdk_client(use_cli: bool):
    ensure_default_ca()
    from daytona import Daytona, DaytonaConfig
    if not use_cli:
        return Daytona()
    # CLI owns refresh-token rotation; its read-only inventory request refreshes login first.
    result = subprocess.run(['daytona', 'list', '--format', 'json'], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Daytona CLI login refresh failed; run daytona login')
    path = Path.home() / ('Library/Application Support/daytona/config.json' if sys.platform == 'darwin' else '.config/daytona/config.json')
    return Daytona(DaytonaConfig(**cli_sdk_config(path)))


def snapshot_build_command(snapshot: str, *, cpu: int = 2, memory: int = 4, disk: int = 10) -> list[str]:
    if not snapshot or not snapshot.strip():
        raise ValueError('Explicit snapshot name required')
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in (cpu, memory, disk)):
        raise ValueError('Snapshot resources must be positive integers')
    return ['daytona', 'snapshot', 'create', snapshot, '--dockerfile',
            'deploy/daytona/Dockerfile', '--context', '.', '--cpu', str(cpu),
            '--memory', str(memory), '--disk', str(disk), '--sandbox-class', 'container']


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build', 'create', 'reconnect', 'refresh', 'status', 'watch', 'login-link'])
    parser.add_argument('--state', type=Path, default=STATE_DEFAULT)
    parser.add_argument('--snapshot')
    parser.add_argument('--name', default='outreach-runtime')
    parser.add_argument('--workspace', default='default')
    parser.add_argument('--interval', type=int, default=300)
    parser.add_argument('--cpu', type=int, default=2, help='Snapshot CPU cores (account quota applies)')
    parser.add_argument('--memory', type=int, default=4, help='Snapshot memory in GB (account quota applies)')
    parser.add_argument('--disk', type=int, default=10, help='Snapshot disk in GB (account quota applies)')
    parser.add_argument('--cli-auth', action='store_true', help='Explicitly reuse the currently selected owner-only Daytona CLI login')
    args = parser.parse_args(argv)
    if args.command == 'login-link':
        parser.error('Open Carl-Allen Settings > Accounts and select Connect or Reconnect. Private browser access now requires an authenticated, account-specific human session; a shared desktop link cannot sign in.')
    if args.command == 'build':
        if not args.snapshot:
            parser.error('--snapshot is required')
        subprocess.run(snapshot_build_command(args.snapshot, cpu=args.cpu, memory=args.memory, disk=args.disk), cwd=ROOT, check=True)
        return 0
    from daytona import CreateSandboxFromSnapshotParams
    client = sdk_client(args.cli_auth)
    if args.command in ('create', 'reconnect'):
        result = ensure_runtime(client, args.state, snapshot=args.snapshot, name=args.name,
                                workspace=args.workspace, create=args.command == 'create',
                                params_factory=CreateSandboxFromSnapshotParams)
        print(json.dumps(result))
        return 0
    state = private_read(args.state)
    sandbox = client.get(state['sandboxId'])
    if (getattr(sandbox, 'labels', {}) or {}).get('app') != 'outreach':
        raise ValueError('Sandbox ownership label mismatch')
    if args.command == 'status':
        result = sandbox.process.exec('node deploy/daytona/healthcheck.mjs', cwd='/opt/outreach', timeout=10)
        print(result.result)
        return 0 if result.exit_code == 0 else 1
    if args.interval < 30 or args.interval > 1800:
        parser.error('--interval must be 30..1800 seconds')
    while True:
        state = refresh_connection(sandbox, state)
        private_write(args.state, state)
        if args.command == 'refresh':
            print(json.dumps({'refreshed': True, 'sandboxId': sandbox.id, 'credentialsPrinted': False}))
            return 0
        time.sleep(args.interval)
        if args.cli_auth:
            close = getattr(client, 'close', None)
            if close: close()
            client = sdk_client(True)
            sandbox = client.get(state['sandboxId'])


if __name__ == '__main__':
    try:
        raise SystemExit(cli())
    except (RuntimeError, ValueError, TimeoutError) as error:
        raise SystemExit(str(error)) from None
