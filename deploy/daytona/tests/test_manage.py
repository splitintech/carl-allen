import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('outreach_daytona_manage', Path(__file__).resolve().parents[1] / 'manage.py')
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class Process:
    def __init__(self): self.calls = []
    def exec(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command.startswith('cat '):
            return SimpleNamespace(exit_code=0, result=json.dumps({'token': 'fixture-engine-token', 'expiresAt': '2099-01-01'}))
        return SimpleNamespace(exit_code=0, result='{"ready":true}')


class Sandbox:
    id = 'fixture-sandbox'
    labels = {'app': 'outreach'}
    state = 'started'
    auto_pause_interval = 1
    def __init__(self): self.process = Process(); self.settings = []
    def set_public(self, x): self.settings.append(('public', x))
    def set_autostop_interval(self, x): self.settings.append(('autostop', x))
    def set_auto_delete_interval(self, x): self.settings.append(('autodelete', x))
    def set_auto_pause_interval(self, x): self.settings.append(('autopause', x))
    def get_preview_link(self, port): return SimpleNamespace(url=f'https://{port}-fixture.invalid', token='fixture-preview-token')
    def create_signed_preview_url(self, port, **kwargs): return SimpleNamespace(url=f'https://{port}-signed.invalid')
    def start(self, **kwargs): self.state = 'started'


class Client:
    def __init__(self): self.sandbox = Sandbox(); self.created = []
    def create(self, params, **kwargs): self.created.append(params); return self.sandbox
    def get(self, sandbox_id):
        if sandbox_id != self.sandbox.id: raise RuntimeError('not found')
        return self.sandbox


class CertificateTrustTest(unittest.TestCase):
    def test_explicit_certificate_configuration_is_preserved_even_if_empty_or_invalid(self):
        for key, value in [('SSL_CERT_FILE', '/missing/custom.pem'), ('SSL_CERT_DIR', '/custom/roots'), ('SSL_CERT_FILE', '')]:
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}, clear=True), \
                    patch.object(manage.ssl, 'get_default_verify_paths') as defaults:
                manage.ensure_default_ca()
                self.assertEqual(dict(os.environ), {key: value})
                defaults.assert_not_called()

    def test_system_default_file_and_lazy_directory_trust_are_preserved(self):
        for cafile, capath in [('/system/ca.pem', None), (None, '/system/certs')]:
            with self.subTest(cafile=cafile, capath=capath), patch.dict(os.environ, {}, clear=True), \
                    patch.object(manage.ssl, 'get_default_verify_paths', return_value=SimpleNamespace(cafile=cafile, capath=capath)), \
                    patch.object(manage.ssl, 'create_default_context') as context:
                manage.ensure_default_ca()
                self.assertNotIn('SSL_CERT_FILE', os.environ)
                context.assert_not_called()

    def test_native_default_roots_without_paths_are_preserved(self):
        context = Mock()
        context.cert_store_stats.return_value = {'x509_ca': 4}
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(manage.ssl, 'get_default_verify_paths', return_value=SimpleNamespace(cafile=None, capath=None)), \
                patch.object(manage.ssl, 'create_default_context', return_value=context):
            manage.ensure_default_ca()
            self.assertNotIn('SSL_CERT_FILE', os.environ)

    def test_sdk_uses_certifi_before_construction_only_when_default_roots_are_absent(self):
        context = Mock()
        context.cert_store_stats.return_value = {'x509_ca': 0}
        observed = []
        sdk = SimpleNamespace(Daytona=lambda: observed.append(os.environ.get('SSL_CERT_FILE')), DaytonaConfig=Mock())
        certifi = SimpleNamespace(where=Mock(return_value='/sdk/certifi/cacert.pem'))
        with patch.dict(os.environ, {}, clear=True), patch.dict('sys.modules', {'daytona': sdk, 'certifi': certifi}), \
                patch.object(manage.ssl, 'get_default_verify_paths', return_value=SimpleNamespace(cafile=None, capath=None)), \
                patch.object(manage.ssl, 'create_default_context', return_value=context) as create_context:
            manage.sdk_client(False)
            self.assertEqual(observed, ['/sdk/certifi/cacert.pem'])
            create_context.assert_called_once_with()
            certifi.where.assert_called_once_with()
            # Repeated calls preserve the selected explicit trust configuration.
            manage.ensure_default_ca()
            create_context.assert_called_once_with()


class LifecycleTest(unittest.TestCase):
    def test_legacy_shared_login_link_redirects_to_owned_session_before_sdk_access(self):
        with patch.object(manage, 'sdk_client') as client, patch('sys.stderr'):
            with self.assertRaises(SystemExit) as result:
                manage.cli(['login-link'])
        self.assertEqual(result.exception.code, 2)
        client.assert_not_called()

    def test_build_uses_explicit_container_class_and_configurable_quota_sized_resources(self):
        command = manage.snapshot_build_command('reviewed-source')
        self.assertEqual(command[command.index('--disk') + 1], '10')
        self.assertEqual(command[command.index('--sandbox-class') + 1], 'container')
        command = manage.snapshot_build_command('reviewed-source', cpu=1, memory=2, disk=8)
        self.assertEqual(command[command.index('--disk') + 1], '8')
        self.assertEqual(command[command.index('--memory') + 1], '2')
        for bad in [0, -1, True]:
            with self.assertRaises(ValueError): manage.snapshot_build_command('source', disk=bad)

    def test_create_is_private_indefinite_and_has_no_fuse_volumes(self):
        params = manage.create_spec('reviewed-snapshot-v1', 'outreach')
        self.assertFalse(params['public'])
        self.assertEqual(params['auto_stop_interval'], 0)
        self.assertEqual(params['auto_pause_interval'], 0)
        self.assertEqual(params['auto_delete_interval'], -1)
        self.assertNotIn('volumes', params)

    def test_reconnect_reuses_saved_sandbox_and_refreshes_separate_tokens(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'connection.json'; client = Client()
            result = manage.ensure_runtime(client, path, snapshot='s1', name='outreach', workspace='ws', create=True, params_factory=lambda **x: x)
            self.assertTrue(result['ready']); self.assertNotIn('apiToken', result)
            state = manage.private_read(path)
            self.assertEqual(state['apiToken'], 'fixture-engine-token')
            self.assertEqual(state['previewToken'], 'fixture-preview-token')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            manage.ensure_runtime(client, path, snapshot=None, name='ignored', workspace='ws', create=False, params_factory=lambda **x:x)
            self.assertEqual(len(client.created), 1)
            self.assertIn(('autostop',0),client.sandbox.settings)
            self.assertIn(('public',False),client.sandbox.settings)

    def test_failed_readiness_retains_identity_and_create_cannot_duplicate(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'state.json'; client=Client()
            with patch.object(manage,'bootstrap',side_effect=TimeoutError('not ready')):
                with self.assertRaises(TimeoutError): manage.ensure_runtime(client,path,snapshot='s',name='outreach',workspace='ws',create=True,params_factory=lambda **x:x)
            self.assertEqual(manage.private_read(path)['sandboxId'],client.sandbox.id)
            with self.assertRaises(ValueError): manage.ensure_runtime(client,path,snapshot='s',name='outreach',workspace='ws',create=True,params_factory=lambda **x:x)
            self.assertEqual(len(client.created),1)

    def test_private_state_rejects_symlinks_and_readable_files(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'state.json'; manage.private_write(path,{'sandboxId':'id'})
            path.chmod(0o644)
            with self.assertRaises(ValueError):manage.private_read(path)
            alias=Path(root)/'alias.json';alias.symlink_to(path)
            with self.assertRaises(ValueError):manage.private_write(alias,{})

    def test_remote_failure_does_not_expose_credentials(self):
        sandbox=Sandbox()
        sandbox.process.exec=lambda *a,**kw:SimpleNamespace(exit_code=1,result='secret-token')
        with self.assertRaisesRegex(RuntimeError,'private sandbox') as caught:manage.run_remote(sandbox,'bad')
        self.assertNotIn('secret-token',str(caught.exception))

    def test_ownership_guard_refuses_an_unrelated_saved_sandbox(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'state.json';client=Client();client.sandbox.labels={'app':'other'}
            manage.private_write(path,{'sandboxId':client.sandbox.id})
            with self.assertRaisesRegex(ValueError,'ownership'):manage.ensure_runtime(client,path,snapshot=None,name='outreach',workspace='ws',create=False,params_factory=lambda **x:x)

    def test_live_view_keeps_signed_query_and_places_path_before_it(self):
        self.assertEqual(manage.live_view_url('https://preview.invalid/?token=signed%2Bvalue&resize=old'),
                         'https://preview.invalid/vnc.html?token=signed%2Bvalue&autoconnect=true&resize=scale')
        self.assertEqual(manage.live_view_url('https://6080-signed.invalid'),
                         'https://6080-signed.invalid/vnc.html?autoconnect=true&resize=scale')
        with self.assertRaises(ValueError): manage.live_view_url('http://preview.invalid/?token=x')

    def test_watch_refresh_recovers_stale_token_and_preserves_ceiling(self):
        sandbox = Sandbox()
        tokens = iter([
            {'token':'expired','expiresAt':'2000-01-01T00:00:00Z','role':'viewer'},
            {'token':'renewed','expiresAt':'2099-01-01T00:00:00Z','role':'viewer'},
        ])
        sandbox.process.exec = lambda *a,**kw: SimpleNamespace(exit_code=0,result=json.dumps(next(tokens)))
        with patch.object(manage,'bootstrap') as recover:
            state=manage.refresh_connection(sandbox,{'workspace':'ws'})
        recover.assert_called_once_with(sandbox,'ws')
        self.assertEqual(state['apiToken'],'renewed'); self.assertEqual(state['apiTokenRole'],'viewer')

    def test_failed_renewal_never_copies_expired_token(self):
        sandbox=Sandbox()
        sandbox.process.exec=lambda *a,**kw:SimpleNamespace(exit_code=0,result='{"token":"expired","expiresAt":"2000-01-01"}')
        with patch.object(manage,'bootstrap'),patch.object(manage.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'previous local connection was preserved'):
                manage.refresh_connection(sandbox,{})


if __name__ == '__main__':unittest.main()
