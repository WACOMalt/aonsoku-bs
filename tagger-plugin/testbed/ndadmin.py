#!/usr/bin/env python3
"""Calls the test bed Navidrome's native API as its admin.

    ndadmin.py METHOD PATH [json-body]
"""
import json
import os
import sys
import urllib.error
import urllib.request

TESTBED = os.environ.get('TESTBED', os.path.expanduser('~/aonsoku-tagger-testbed'))
BASE = f"http://127.0.0.1:{os.environ.get('PORT', '4533')}"
env = dict(l.strip().split('=', 1) for l in open(f'{TESTBED}/admin.env') if '=' in l)


def request(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-ND-Authorization'] = f'Bearer {token}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]


token = request('POST', '/auth/login', {'username': env['TESTBED_USER'], 'password': env['TESTBED_PASS']})[1]['token']
body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
status, reply = request(sys.argv[1], sys.argv[2], body, token)
print(status, json.dumps(reply, ensure_ascii=False) if not isinstance(reply, str) else reply)
