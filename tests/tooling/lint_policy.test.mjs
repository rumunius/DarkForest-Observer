import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {ESLint} from 'eslint';
import {validSourceName} from '../../scripts/check_source_names.mjs';

const root = resolve(import.meta.dirname, '../..');
const eslint = new ESLint({cwd: root});

test('filenames allow documented entry points and reject new kebab/camel names', () => {
  for (const name of [
    'apps/web/src/rule_text.ts',
    'tests/unit/frontend.test.ts',
    'apps/web/vite.config.ts',
    'apps/web/functions/_middleware.ts',
    'scripts/admin_protocol.d.mts',
  ]) {
    assert.equal(validSourceName(name), true, name);
  }
  for (const name of [
    'apps/web/src/new-page.tsx',
    'apps/web/src/newPage.ts',
    'apps/web/src/vite.config.ts',
  ]) {
    assert.equal(validSourceName(name), false, name);
  }
});

test('the normal gate enforces style and frontend import boundaries', async () => {
  const [result] = await eslint.lintText(
    "import {secret} from '../../match-worker/src/security/crypto';\nexport const value = secret;\nif (value) console.log(value);\n",
    {filePath: 'apps/web/src/app.tsx'},
  );
  const rules = result.messages.map(message => message.ruleId);
  assert.ok(rules.includes('curly'));
  assert.ok(rules.includes('no-restricted-imports'));
});

test('all project TypeScript rejects floating promises, unsafe JSON and hook misuse', async () => {
  const [typed] = await eslint.lintText(
    "export function probe() {\nPromise.resolve(1);\nconst value = JSON.parse('{}');\nreturn value.secret;\n}\n",
    {filePath: 'apps/web/src/data/http.ts'},
  );
  const rules = typed.messages.map(message => message.ruleId);
  assert.ok(rules.includes('@typescript-eslint/no-floating-promises'));
  assert.ok(rules.includes('@typescript-eslint/no-unsafe-assignment'));
  const [hooks] = await eslint.lintText(
    "import {useEffect} from 'react';\nexport function Probe({enabled}: {enabled: boolean}) {\nif (enabled) {useEffect(() => {}, []);}\nreturn null;\n}\n",
    {filePath: 'apps/web/src/app.tsx'},
  );
  assert.ok(
    hooks.messages.some(
      message => message.ruleId === 'react-hooks/rules-of-hooks',
    ),
  );
  const [deps] = await eslint.lintText(
    "import {useEffect} from 'react';\nexport function Probe({value}: {value: string}) {\nuseEffect(() => {document.title = value;}, []);\nreturn null;\n}\n",
    {filePath: 'apps/web/src/app.tsx'},
  );
  assert.ok(
    deps.messages.some(
      message => message.ruleId === 'react-hooks/exhaustive-deps',
    ),
  );
});
