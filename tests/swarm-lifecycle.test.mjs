import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ordinary pushes and schedules cannot start or recover model agents', async () => {
  const workflow = await readFile(new URL('../.github/workflows/shurik.yml', import.meta.url), 'utf8');
  const triggers = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1];
  assert.ok(triggers, 'the model workflow must declare its triggers');
  assert.match(triggers, /^  workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /^  (?:push|schedule|workflow_run|repository_dispatch):/m,
    'a repository rename or catalogue update must never reactivate a paused swarm');
  assert.doesNotMatch(workflow, /github\.event_name == 'push'|steps\.launch\.outputs/,
    'model startup requires an explicit start/resume command');
});
