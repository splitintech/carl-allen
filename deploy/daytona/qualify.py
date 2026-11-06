#!/usr/bin/env python3
"""Read-only live qualification: verify explicit action IDs against the deployed authenticated API."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from manage import private_read, private_write


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_url(base: str, path: str) -> str:
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password:
        raise ValueError('Live qualification requires an HTTPS preview URL')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '/' + path.lstrip('/'), parsed.query, ''))


def fetch_json(connection: dict, path: str) -> dict:
    headers = {'Authorization': 'Bearer ' + connection['apiToken'], 'X-Daytona-Skip-Preview-Warning': 'true'}
    if connection.get('previewToken'):
        headers['X-Daytona-Preview-Token'] = connection['previewToken']
    request = Request(api_url(connection['apiUrl'], path), headers=headers)
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f'Qualification API returned HTTP {error.code}; no redirect followed') from None


def verify_action(case: dict, observed: dict) -> dict:
    failures = []
    if observed.get('kind') != case['kind']:
        failures.append('kind_mismatch')
    if observed.get('provider_account_id') != case['accountId']:
        failures.append('account_mismatch')
    if observed.get('state') != case.get('expectedState', 'succeeded'):
        failures.append('state_mismatch')
    receipts = [attempt.get('receipt') for attempt in observed.get('attempts', []) if attempt.get('receipt')]
    if case.get('expectedState', 'succeeded') == 'succeeded':
        native = [r.get('providerMessageId') for r in receipts if isinstance(r, dict)]
        if not native or any(not value or value.startswith(('fake:', 'linkedin:publish:', 'linkedin:message:', 'manual:')) for value in native):
            failures.append('missing_native_receipt')
    return {'actionId': observed.get('id'), 'kind': observed.get('kind'), 'accountId': observed.get('provider_account_id'),
            'state': observed.get('state'), 'receipts': receipts, 'passed': not failures, 'failures': failures}


def cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--cases', type=Path, required=True, help='Explicit action IDs already created/approved by the operator; never sends')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    connection = private_read(args.state)
    spec = json.loads(args.cases.read_text())
    cases = spec.get('actions', [])
    if not cases:
        parser.error('At least one explicitly selected action is required')
    for case in cases:
        if not case.get('actionId') or not case.get('accountId') or case.get('kind') not in ('social.publish', 'social.message', 'social.connect', 'browser.task', 'email.send', 'email.reply'):
            parser.error('Each case requires actionId, accountId and a supported kind')
        if not case['actionId'].isalnum():
            parser.error('Invalid action ID')
    me = fetch_json(connection, 'v1/me')
    accounts = {row['id']: row for row in fetch_json(connection, 'v1/accounts').get('accounts', [])}
    results = []
    for case in cases:
        row = verify_action(case, fetch_json(connection, 'v1/actions/' + case['actionId']))
        account = accounts.get(case['accountId'], {})
        allowed = ('gmail', 'outlook') if case['kind'].startswith('email.') else ('social-browser',)
        if account.get('provider') not in allowed:
            row['passed'] = False
            row['failures'].append('unqualified_or_fake_provider')
        if not case['kind'].startswith('email.') and account.get('capabilities', {}).get('executionPlacement') != 'daytona-browser':
            row['passed'] = False
            row['failures'].append('missing_daytona_placement')
        results.append(row)
    result = {'sandboxId': connection['sandboxId'], 'snapshot': connection.get('snapshot'), 'workspaceId': me.get('workspaceId'),
              'observedAt': int(time.time() * 1000), 'actions': results,
              'passed': all(row['passed'] for row in results),
              'unverifiedGates': ['human Papr desktop acceptance', 'Mac-off scheduling', 'restart/profile recovery', 'checkpoint/reconnect recovery', 'kill-switch and caps live acceptance']}
    private_write(args.output, result)
    print(json.dumps({'passed': result['passed'], 'verifiedActions': len(results), 'report': str(args.output),
                      'unverifiedGates': result['unverifiedGates'], 'credentialsPrinted': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(cli())
