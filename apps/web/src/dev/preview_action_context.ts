import type {Operation, Snapshot} from '@darkforest/contracts';
/** Saved preview form and simulated revision; this never grants server authorization. */
export interface SavedPreview {
  revision: number;
  path: string;
  payload: Record<string, unknown>;
}
/** Presentation feedback shared by preview mutation stages before the receipt is saved. */
export interface PreviewFeedback {
  title: string;
  message: string;
  code: string | undefined;
}
/** The simulator's existing mutable state and operation; no network or server storage access. */
export interface PreviewActionContext {
  readonly state: Snapshot;
  readonly match: NonNullable<Snapshot['match']>;
  readonly operation: Operation;
  readonly previews: Map<string, SavedPreview>;
  readonly sightingResult: string;
}
