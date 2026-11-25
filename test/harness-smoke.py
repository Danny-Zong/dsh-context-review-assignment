"""Exercise Context Review in an isolated Windows Harness SDK process."""

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


def main(installation):
    project = Path(__file__).resolve().parents[1]
    installation = installation.resolve()
    packages = installation / 'resources/app.asar/dsh/node_modules/@deepseek-ai'
    replies = queue.Queue()
    diagnostics = []
    finished = threading.Event()
    with tempfile.TemporaryDirectory(prefix='dsh-context-review-', ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        fixture = root / 'fixture.mjs'
        fixture.write_text((project / 'fixtures/native-harness.mjs').read_text(encoding='utf-8').replace(
            '__LLM_MODULE__', (packages / 'dsh-llm/lib/index.js').as_uri(),
        ), encoding='utf-8')
        patch = root / 'fixture.yml'
        patch.write_text(f'''- insert:
    - id: exercise-workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: exercise-connection
      name: '@deepseek-ai/dsh-client-connection'
    - id: exercise-file-uploads
      name: '@deepseek-ai/dsh-client-file-upload'
    - id: exercise-session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
      config:
        nativeOpen: false
    - id: dsh-context-review
      name: {json.dumps((project / 'host.mjs').as_posix())}
    - id: exercise-adapter
      name: {json.dumps(fixture.as_posix())}
- id: session-telemetry-otel
  enabled: false
- id: session-title-llm
  enabled: false
''', encoding='utf-8')
        env = dict(os.environ, DSH_HOME=str(root / 'home'), ELECTRON_RUN_AS_NODE='1')
        for key in ('DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'):
            env.pop(key, None)
        with subprocess.Popen([
            str(installation / 'DeepSeek Harness.exe'), '--expose-internals',
            str(packages / 'dsh-desktop-host/lib/cli.js'), '--profile', 'sdk', '--patch', str(patch),
        ], env=env, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW) as child:
            def read_protocol():
                for line in child.stdout:
                    try:
                        replies.put(json.loads(line))
                    except json.JSONDecodeError:
                        diagnostics.append(line)

            def read_errors():
                for line in child.stderr:
                    diagnostics.append(line)
                    if line.startswith('CONTEXT_REVIEW_SMOKE_'):
                        finished.set()

            threading.Thread(target=read_protocol, daemon=True).start()
            threading.Thread(target=read_errors, daemon=True).start()
            number = 0

            def call(method, **params):
                nonlocal number
                number += 1
                child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params}) + '\n')
                child.stdin.flush()
                deadline = time.monotonic() + 10
                while True:
                    reply = replies.get(timeout=max(0, deadline - time.monotonic()))
                    if reply.get('id') == number:
                        assert 'error' not in reply, reply
                        return reply.get('result')

            try:
                session = 'context-review-native'
                call('initialize', cwd=str(root), model='offline', provider='a2-offline')
                for text in ('Keep Wednesdays free. Keep Sundays free.', 'Wednesdays might be free in November.'):
                    call('session/prompt', sessionId=session, contentBlocks=[{'type': 'text', 'text': text}])
                    call('session/wait', sessionId=session)
                assert finished.wait(timeout=18), 'The native fixture did not finish.'
                assert 'CONTEXT_REVIEW_SMOKE_OK\n' in diagnostics, 'The native fixture reported a failure.'
                call('shutdown')
                child.stdin.close()
                assert child.wait(timeout=10) == 0
            except Exception:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                print(''.join(diagnostics)[-6000:])
                raise
    print('Harness verified the held and rebuilt request, durable scoped decision, native retry branch, and controlled scoring.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('installation', type=Path, help='Directory containing DeepSeek Harness.exe')
    main(parser.parse_args().installation)
