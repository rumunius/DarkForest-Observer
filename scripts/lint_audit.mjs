import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {ESLint} from 'eslint';

const root = resolve(import.meta.dirname, '..');
const baselinePath = resolve(root, 'config/lint_audit_baseline.json');

/** Fingerprints survive line moves, but identify the rule, message and offending source. */
export function auditEntries(results) {
  const entries = new Map();
  for (const result of results) {
    const lines = (result.source ?? '').split(/\r?\n/);
    for (const message of result.messages) {
      const fragment = lines
        .slice(message.line - 1, message.endLine ?? message.line)
        .map((line, index, selected) => {
          const start = index === 0 ? message.column - 1 : 0;
          const end =
            index === selected.length - 1
              ? (message.endColumn ?? line.length + 1) - 1
              : line.length;
          return line.slice(start, end);
        })
        .join('\n')
        .replace(/\s+/g, ' ');
      const entry = {
        file: relative(root, result.filePath).replaceAll('\\', '/'),
        rule: message.ruleId ?? 'parser-error',
        message: message.message,
        fingerprint: createHash('sha256').update(fragment).digest('hex'),
      };
      const key = JSON.stringify(entry);
      const current = entries.get(key);
      if (current) {
        current.count++;
      } else {
        entries.set(key, {...entry, count: 1});
      }
    }
  }
  return [...entries.values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/** Additions fail; removals must also shrink the reviewed baseline. */
export function compareAudit(current, baseline) {
  const key = entry =>
    JSON.stringify([entry.file, entry.rule, entry.message, entry.fingerprint]);
  const expected = new Map(baseline.map(entry => [key(entry), entry.count]));
  const actual = new Map(current.map(entry => [key(entry), entry.count]));
  return {
    added: current.filter(
      entry => entry.count > (expected.get(key(entry)) ?? 0),
    ),
    removed: baseline.filter(
      entry => entry.count > (actual.get(key(entry)) ?? 0),
    ),
  };
}

async function main() {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: resolve(root, 'eslint.audit.config.mjs'),
  });
  const results = await eslint.lintFiles(['.']);
  if (
    results.some(result =>
      result.messages.some(message => message.fatal || !message.ruleId),
    )
  ) {
    throw new Error(
      'Audit contains parser/configuration failures; these cannot be baselined.',
    );
  }
  const entries = auditEntries(results);
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const directory = resolve(root, '.tmp/style-migration');
  await mkdir(directory, {recursive: true});
  await writeFile(
    resolve(directory, 'lint-audit.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  const summary = new Map();
  for (const entry of entries) {
    summary.set(entry.rule, (summary.get(entry.rule) ?? 0) + entry.count);
  }
  console.table(Object.fromEntries([...summary].sort((a, b) => b[1] - a[1])));
  console.log(
    `Full typed audit: ${total} reports in ${new Set(entries.map(entry => entry.file)).size} files. Details: .tmp/style-migration/lint-audit.json`,
  );
  if (process.argv.includes('--write-baseline')) {
    await mkdir(resolve(root, 'config'), {recursive: true});
    await writeFile(
      baselinePath,
      JSON.stringify({version: 1, entries}, null, 2) + '\n',
    );
    console.log(
      'Wrote migration baseline. Review every addition before accepting this change.',
    );
    return;
  }
  if (process.argv.includes('--ratchet')) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    if (baseline.version !== 1 || !Array.isArray(baseline.entries)) {
      throw new Error('Invalid audit baseline');
    }
    const difference = compareAudit(entries, baseline.entries);
    if (difference.added.length || difference.removed.length) {
      console.error(JSON.stringify(difference, null, 2));
      console.error(
        'Typed audit changed. Fix new reports; remove resolved baseline entries after review.',
      );
      process.exitCode = 1;
    } else {
      console.log('Typed audit baseline unchanged; no new reports.');
    }
    return;
  }
  if (total) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
