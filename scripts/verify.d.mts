import type { BackupProblem } from './backup.mjs';

export interface Orphan { path: string; type: 'file' | 'directory' | 'other'; size: number | null }
export interface DataDirVerification {
  ok: boolean; databaseOk: boolean; databaseError: string | null; files: number; previews: number; hashed: number;
  legacyWithoutHash: number; quick: boolean; problems: BackupProblem[]; orphans: Orphan[];
}
export interface BackupVerification {
  ok: boolean; version: 1 | 2; createdAt: string | null; files: number; quick: boolean; databaseOk: boolean; databaseError: string | null;
  /** Damage found now inside the copy. */ problems: (BackupProblem & { database?: true })[];
  /** Paths where the copy's database and manifest disagree. */ differences: string[];
  /** Problems recorded when the copy was made. */ recorded: BackupProblem[]; recovered: BackupProblem[];
}
export declare function verifyDataDir(dataDirectory: string, options?: { quick?: boolean }): Promise<DataDirVerification>;
export declare function verifyBackup(backupDirectory: string, options?: { quick?: boolean }): Promise<BackupVerification>;
