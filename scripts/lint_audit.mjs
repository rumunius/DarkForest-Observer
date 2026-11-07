import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {ESLint} from 'eslint';

const root = resolve(import.meta.dirname, '..');

async function main() {
  if (process.argv.length > 2) {
    throw new Error(
      'Migration baselines have been removed; lint:audit accepts no options.',
    );
  }
  const results = await new ESLint({cwd: root}).lintFiles(['.']);
  const directory = resolve(root, '.tmp/style-migration');
  await mkdir(directory, {recursive: true});
  await writeFile(
    resolve(directory, 'lint-audit.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  const summary = new Map();
  let total = 0;
  for (const result of results) {
    for (const message of result.messages) {
      const rule = message.ruleId ?? 'parser-error';
      summary.set(rule, (summary.get(rule) ?? 0) + 1);
      total++;
    }
  }
  if (total) {
    console.table(Object.fromEntries(summary));
  }
  console.log(
    `Full typed audit: ${total} reports. Details: .tmp/style-migration/lint-audit.json`,
  );
  if (total) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
