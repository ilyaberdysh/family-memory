import type { DatabaseSync } from 'node:sqlite';
import type { Stats } from 'node:fs';

export declare const STATUS_FILE: 'backup-status.json';
export declare const IN_PROGRESS_MARKER: '.backup-in-progress';

/** A file the backup could not keep exactly as the database describes it. `recovered`: the live file was damaged,
 * but the snapshot holds the intact earlier version from `linkDest`. `preview`: browser copy, regenerable from the original. */
export interface BackupProblem {
  path: string | null;
  kind: 'missing' | 'size' | 'checksum' | 'invalid';
  expectedSize?: number | null;
  actualSize?: number;
  expectedSha256?: string;
  actualSha256?: string;
  expectedFrom?: 'previous-backup';
  preview?: true;
  recovered?: true;
  error?: string;
  fileId?: string;
  reason?: 'name' | 'size' | 'sha256' | 'duplicate' | 'record';
}
export interface ManifestEntry { path: string; size: number; sha256: string }
export interface BackupManifest { format: 'family-space-backup'; version: 1 | 2; createdAt?: string; database: ManifestEntry; files: ManifestEntry[]; problems: BackupProblem[] }
export interface BackupResult { destination: string; files: number; problems: BackupProblem[]; bytesCopied: number; bytesLinked: number }
export interface BackupOptions {
  /** A previous complete snapshot; unchanged verified files are hard-linked from it instead of copied. */
  linkDest?: string;
  signal?: AbortSignal;
  /** false: do not write DATA_DIR/backup-status.json. */
  statusFile?: boolean;
  warn?: (message: string) => void;
}
/** Contents of DATA_DIR/backup-status.json. Counts and destination describe the last completed (ok/degraded) backup. */
export interface BackupStatusFile {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: 'ok' | 'degraded' | 'failed' | null;
  lastError: string | null;
  lastDestination: string | null;
  problemFiles: number;
  files: number;
  bytesCopied: number;
  bytesLinked: number;
}
export interface FileReference { path: string; size: number | null; sha256: string | null; preview: boolean }
export interface InvalidReference { fileId: string; path: string | null; preview: boolean; reason: NonNullable<BackupProblem['reason']> }
export interface References { files: Map<string, FileReference>; invalid: InvalidReference[] }

export declare function createBackup(dataDirectory: string, destination: string, options?: BackupOptions): Promise<BackupResult>;
export declare function readManifest(directory: string): Promise<BackupManifest>;
export declare function recordBackupStatus(dataDirectory: string, patch: Partial<BackupStatusFile>, warn?: (message: string) => void): Promise<void>;
export declare function collectReferences(db: DatabaseSync): References;
export declare function unexplainedDifferences(references: References, manifest: BackupManifest): string[];
export declare function describeProblem(problem: BackupProblem): string;
export declare function problemFileCount(problems: BackupProblem[]): number;
export declare function checkDatabase(db: DatabaseSync): void;
export declare function safeFilename(value: unknown): string;
export declare function regularFile(path: string): Promise<Stats>;
export declare function digest(path: string): Promise<string>;
export declare function formatBytes(bytes: number): string;
