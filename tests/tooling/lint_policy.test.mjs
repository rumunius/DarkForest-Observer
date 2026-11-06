import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {ESLint} from 'eslint';
import {validSourceName} from '../../scripts/check_source_names.mjs';

const root = resolve(import.meta.dirname, '../..');
const eslint = new ESLint({cwd: root});

test('module layout rejects late imports without reordering side effects automatically', async () => {
  const [result] = await eslint.lintText(
    "import console from 'node:console';\nconsole.log('ready');\nimport 'node:fs';\n",
    {filePath: 'scripts/local_init.mjs'},
  );
  const reports = result.messages.filter(
    message => message.ruleId === 'project/module-layout',
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].line, 3);
  assert.equal(reports[0].messageId, 'late');
  assert.equal(reports[0].fix, undefined);
});

test('module section separation preserves documentation, trailing comments and import groups', async () => {
  const fixer = new ESLint({cwd: root, fix: true});
  const source =
    "import console from 'node:console';\n\nimport 'node:fs'; // required side effect\n/** Explains the implementation boundary. */\nconsole.log('ready');\n";
  const [result] = await fixer.lintText(source, {
    filePath: 'scripts/local_init.mjs',
  });
  assert.equal(
    result.output,
    source.replace(
      '// required side effect\n/**',
      '// required side effect\n\n/**',
    ),
  );
  const [stable] = await fixer.lintText(result.output, {
    filePath: 'scripts/local_init.mjs',
  });
  assert.equal(stable.output, undefined);
  assert.equal(stable.messages.length, 0);
  for (const text of ["import 'node:fs';\n", "console.log('ready');\n"]) {
    const [singleSection] = await eslint.lintText(text, {
      filePath: 'scripts/local_init.mjs',
    });
    assert.equal(
      singleSection.messages.filter(
        message => message.ruleId === 'project/module-layout',
      ).length,
      0,
    );
  }
  const [typed] = await fixer.lintText(
    "import type {Session} from '@darkforest/contracts';\n/** Reads the current account identifier for callers. */\nexport function identity(session: Session) {return session.id;}\n",
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.ok(typed.output.includes("from '@darkforest/contracts';\n\n/**"));
  assert.equal(typed.messages.length, 0);
});

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
  assert.ok(rules.includes('project/documented-exports'));
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

test('framework default-export exceptions still reject erased enums and undocumented APIs', async () => {
  const [result] = await eslint.lintText(
    'const enum Probe {Value}\nexport default {};\nexport function undocumented() {}\n',
    {filePath: 'apps/match-worker/src/index.ts'},
  );
  assert.ok(
    result.messages.some(message => message.ruleId === 'no-restricted-syntax'),
  );
  assert.ok(
    result.messages.some(
      message => message.ruleId === 'project/documented-exports',
    ),
  );
  assert.equal(
    result.messages.filter(message => message.ruleId === 'no-restricted-syntax')
      .length,
    1,
  );
});

test('class spacing fixes preserve documentation and overload groups', async () => {
  const fixer = new ESLint({cwd: root, fix: true});
  const [result] = await fixer.lintText(
    '/** Stores values with documented overloads. */\nexport class Probe {\nvalue = 0;\n/** Reads the current value. */\nread(): number;\nread(fallback: number): number;\nread(fallback = 0) {return this.value || fallback;}\n/** Clears the current value. */\nclear() {this.value = 0;}\n}\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.ok(result.output.includes('value = 0;\n\n/** Reads'));
  assert.ok(
    result.output.includes(
      'read(): number;\nread(fallback: number): number;\nread(fallback = 0)',
    ),
  );
  assert.ok(result.output.includes('fallback;}\n\n/** Clears'));
  const [stable] = await fixer.lintText(result.output, {
    filePath: 'apps/web/src/data/http.ts',
  });
  assert.equal(stable.output, undefined);
  assert.equal(
    stable.messages.filter(
      message => message.ruleId === 'project/spaced-class-methods',
    ).length,
    0,
  );
});

test('named function declarations allow typed arrows and local callbacks', async () => {
  const [result] = await eslint.lintText(
    '/** Converts a value for callers. */\nexport const convert = (value: string) => value;\nconst typed: (value: string) => string = value => value;\nfunction outer() {const local = () => typed("ok"); return [1].map(() => local());}\nvoid outer;\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  const reports = result.messages.filter(
    message => message.ruleId === 'project/named-functions',
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].line, 2);
});

test('type annotations keep imports and absent values visible at the use site', async () => {
  const [result] = await eslint.lintText(
    'type MaybeName = string | null;\ntype MaybeCount = number | undefined;\nlet value: import("@darkforest/contracts").Session;\nclass Probe {#value = 0;}\nvoid value;\nvoid Probe;\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.equal(
    result.messages.filter(message => message.ruleId === 'no-restricted-syntax')
      .length,
    4,
  );
  const [valid] = await eslint.lintText(
    'type Name = string;\nlet value: Name | null = null;\nvoid value;\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.equal(
    valid.messages.filter(message => message.ruleId === 'no-restricted-syntax')
      .length,
    0,
  );
});

test('compiler suppression is forbidden in product code and narrowly allowed in tests', async () => {
  const source =
    '// @ts-expect-error: checks rejection of an intentionally invalid argument\nconst value: string = 123;\nvoid value;\n';
  const [product] = await eslint.lintText(source, {
    filePath: 'apps/web/src/data/http.ts',
  });
  assert.ok(
    product.messages.some(
      message => message.ruleId === '@typescript-eslint/ban-ts-comment',
    ),
  );
  const [unit] = await eslint.lintText(source, {
    filePath: 'tests/unit/frontend.test.ts',
  });
  assert.equal(
    unit.messages.filter(
      message => message.ruleId === '@typescript-eslint/ban-ts-comment',
    ).length,
    0,
  );
});

test('object literals are checked at declaration rather than asserted into contracts', async () => {
  const [asserted] = await eslint.lintText(
    'interface Probe {code: string;}\nconst value = {code: 123} as Probe;\nvoid value;\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.ok(
    asserted.messages.some(
      message =>
        message.ruleId === '@typescript-eslint/consistent-type-assertions',
    ),
  );
  const [annotated] = await eslint.lintText(
    'interface Probe {code: string;}\nconst value: Probe = {code: "ok"};\nconst literal = {code: "ok"} as const;\nvoid value;\nvoid literal;\n',
    {filePath: 'apps/web/src/data/http.ts'},
  );
  assert.equal(
    annotated.messages.filter(
      message =>
        message.ruleId === '@typescript-eslint/consistent-type-assertions',
    ).length,
    0,
  );
});
