import {readdir} from 'node:fs/promises';
import {basename, relative, resolve} from 'node:path';
import process from 'node:process';
import console from 'node:console';

const root = resolve(import.meta.dirname, '..');
const generated = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  'coverage',
  '.git',
  '.codegraph',
  '.tmp',
  '.private',
  '.firecrawl',
  '.tavily',
  '.npm',
]);
const frameworkFiles = new Set([
  'eslint.config.mjs',
  'vitest.config.ts',
  'vitest.workers.config.ts',
  'apps/web/vite.config.ts',
  'apps/web/functions/_middleware.ts',
]);

/** Framework entry names are explicit exceptions; handwritten files use snake_case. */
export function validSourceName(file) {
  const normalized = file.replaceAll('\\', '/');
  return (
    frameworkFiles.has(normalized) ||
    /^_?[a-z][a-z0-9_]*(?:\.test|\.d)?\.(?:[cm]?[jt]s|tsx)$/.test(
      basename(normalized),
    )
  );
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (generated.has(entry.name)) {
      continue;
    }
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(file)));
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

async function main() {
  const files = await sourceFiles(root);
  const invalid = files
    .map(file => relative(root, file))
    .filter(file => !validSourceName(file));
  if (invalid.length) {
    console.error(
      'Handwritten source filenames must use snake_case:\n' +
        invalid.join('\n'),
    );
    process.exitCode = 1;
  } else {
    console.log(`Source filenames: ${files.length} checked.`);
  }
}

if (import.meta.main) {
  await main();
}
