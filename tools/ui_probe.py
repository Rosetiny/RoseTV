"""Read-only CDP probe for the isolated local app preview."""
import base64
import json
import sys
from pathlib import Path

import requests
import websocket

class Preview:
    def __init__(self, port=9227):
        session = requests.Session()
        session.trust_env = False
        pages = session.get(f'http://127.0.0.1:{port}/json/list', timeout=3).json()
        page = next(page for page in pages if page.get('type') == 'page' and page.get('url', '').startswith('http://tauri.localhost'))
        self.socket = websocket.create_connection(page['webSocketDebuggerUrl'], suppress_origin=True, timeout=20)
        self.identifier = 0
    def call(self, method, params=None):
        self.identifier += 1
        self.socket.send(json.dumps({'id': self.identifier, 'method': method, 'params': params or {}}))
        while True:
            response = json.loads(self.socket.recv())
            if response.get('id') == self.identifier:
                if 'error' in response:
                    raise RuntimeError(response['error'])
                return response.get('result', {})
    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if result.get('exceptionDetails'):
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

if __name__ == '__main__':
    preview = Preview()
    if len(sys.argv) > 1 and sys.argv[1] == 'screenshot':
        target = Path(__file__).resolve().parent.parent / 'performance-preview.png'
        target.write_bytes(base64.b64decode(preview.call('Page.captureScreenshot', {'format': 'png'})['data']))
        print(target)
    else:
        expression = sys.stdin.read()
        print(json.dumps(preview.evaluate(expression), ensure_ascii=True))
