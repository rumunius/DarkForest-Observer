import type {URL} from 'node:url';
export function stable(value: unknown): string;
export function checksum(value: unknown): string;
export function siteUrl(value: string): URL;
export function nextRecoveryAction(
  state: string,
):
  | 'save-carry'
  | 'launch'
  | 'status'
  | 'complete'
  | 'website-review'
  | 'select-checkpoint';
export function assertReleaseSafe(diagnostics: {
  matches: Array<{kind: string; summary: string | {phase?: string}}>;
}): void;
