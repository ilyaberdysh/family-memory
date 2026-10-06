import type { BackupManifest, BackupProblem } from './backup.mjs';

export declare function blockingProblems(manifest: BackupManifest): BackupProblem[];
export declare function restoreBackup(backupDirectory: string, destination: string, appStopped: boolean | undefined, adminEmail?: string, allowProblems?: boolean):
  Promise<{ destination: string; files: number; problems: BackupProblem[]; recovered: BackupProblem[] }>;
