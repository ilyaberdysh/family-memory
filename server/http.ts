import type { Response } from 'express';
import { createHash } from 'node:crypto';
import type { Role, User } from '../shared/types.js';

export class ApiError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }
export function fail(status: number, message: string, code?: string): never { throw new ApiError(status, message, code); }
export const now = () => new Date().toISOString();
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** A person's place in one family: role, admission state and their own card in that family's tree. */
export interface Membership { id: string; familyId: string; userId: string; role: Role; status: 'active' | 'pending' | 'removed' | 'rejected'; personId: string | null; createdAt: string }
export interface Family { id: string; name: string; surnames: string[]; createdBy: string; createdAt: string }

/** The signed-in account as seen inside the current family (role/status/personId come from the membership). */
export const actor = (res: Response): User => res.locals.member as User;
export const familyOf = (res: Response): string => res.locals.familyId as string;
export const asMember = (user: User, membership: Membership): User => ({ ...user, role: membership.role, status: membership.status, personId: membership.personId });
export const writable = (user: User) => { if (user.role === 'viewer') fail(403, 'Наблюдатель может только смотреть.'); };
export const owned = (record: { createdBy: string }, user: User) => { writable(user); if (record.createdBy !== user.id && user.role !== 'admin') fail(403, 'Редактировать может автор или администратор.'); };
export const admin = (user: User) => { if (user.role !== 'admin') fail(403, 'Это действие доступно администратору.'); };
export const requireVersion = (actual: number, expected: number) => { if (actual !== expected) fail(409, 'Запись уже изменилась. Обновите страницу и проверьте новую версию.'); };
