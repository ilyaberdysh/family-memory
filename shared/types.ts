export type Role = 'admin' | 'member' | 'viewer';
export interface User { id: string; name: string; email: string; role: Role; nameParts?: NameParts; phone?: string; phoneVerified?: boolean; telegramId?: string; telegramSubject?: string; authProvider?: 'telegram' | 'guest' | 'local'; status?: 'profile' | 'pending' | 'active' | 'rejected'; personId?: string | null }
export type ReviewStatus = 'unconfirmed' | 'confirmed' | 'disputed';
export type FactKey = 'name' | 'previousName' | 'birthDate' | 'deathDate' | 'place' | 'bio';
export const FACT_LABELS: Record<FactKey, string> = { name: 'ФИО', previousName: 'Прежняя фамилия', birthDate: 'Дата рождения', deathDate: 'Дата смерти', place: 'Место', bio: 'О человеке' };
export interface Reviewed { id: string; version: number; status: ReviewStatus; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string; confirmedBy: string | null; confirmedAt: string | null; source: string; sourceMaterialId?: string | null; sourceQuote?: string | null; sourceStart?: number | null; disputeNote?: string | null; disputedBy?: string | null }
export interface NameParts { firstName: string; lastName: string; patronymic: string }
export interface Person { id: string; name: string; nameParts?: NameParts; avatarFileId: string | null; createdBy: string; createdAt: string }
export interface Fact extends Reviewed { personId: string; key: FactKey; value: string; nameParts?: NameParts }
export type RelationType = 'parent' | 'partner';
export type ParentKind = 'biological' | 'adoptive' | 'unspecified';
export interface Relation extends Reviewed { fromId: string; toId: string; type: RelationType; parentKind: ParentKind }
export interface UploadedFile { id: string; name: string; mime: string; size: number; url: string }
export interface TranscriptSegment { start: number; end: number; text: string }
export interface Transcript { text: string; segments: TranscriptSegment[]; version: number; automatic: boolean; updatedAt: string }
export type ProposalAction = 'create_person' | 'set_fact' | 'create_relation' | 'link_material';
export interface Proposal { nameParts?: NameParts; id: string; action: ProposalAction; status: 'pending' | 'accepted' | 'rejected'; personId: string | null; personName: string | null; key: FactKey | null; value: string | null; fromId: string | null; toId: string | null; fromName: string | null; toName: string | null; relationType: RelationType | null; parentKind: ParentKind | null; sourceQuote: string; sourceStart: number | null; sourceEnd: number | null; baseVersion: number | null }
export type MaterialKind = 'story' | 'photo' | 'audio' | 'video';
export interface Material { extractionRejectedCount?: number; relatedMaterialIds?: string[]; id: string; title: string; kind: MaterialKind; body: string; narrator: string; occurredAt: string; personIds: string[]; file: UploadedFile | null; createdBy: string; createdAt: string; updatedAt: string; version: number; transcriptionStatus: 'idle' | 'queued' | 'processing' | 'done' | 'error'; extractionStatus: 'idle' | 'queued' | 'processing' | 'done' | 'error'; processingError: string | null; transcript?: Transcript | null; proposals?: Proposal[] }
export interface Invitation { id: string; email: string; role: Role; createdAt: string; accepted: boolean }
export interface InvitationLink { id: string; role: 'member' | 'viewer'; createdBy: string; createdAt: string; expiresAt: string; revokedAt: string | null; uses: number; userId?: string | null; usedAt?: string | null }
export interface CreatedInvitationLink { invitation: InvitationLink; token: string }
export interface InvitationPreview { role: 'member' | 'viewer'; expiresAt: string }
export interface HistoryEntry { id: string; entityType: string; entityId: string; actorId: string; action: string; before: string | null; after: string | null; createdAt: string }
export interface AppState { user: User; users: User[]; people: Person[]; facts: Fact[]; relations: Relation[]; materials: Material[]; invitations: Invitation[]; invitationLinks?: InvitationLink[]; settings: { name: string; surnames?: string[]; devMode: boolean; aiAvailable: boolean; maxUploadMb: number } }
export interface AuthConfig { devMode: boolean; mailAvailable: boolean; name: string; surnames?: string[]; telegramAvailable?: boolean }
export interface AuthSession { user: User | null }


export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  file?: UploadedFile | null;
  automatic?: boolean;
  interrupted?: boolean;
}
export type ConversationStatus = 'idle' | 'responding' | 'transcribing' | 'preparing' | 'error';
export interface Conversation {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  messages: ConversationMessage[];
  status: ConversationStatus;
  error: string | null;
  errorOperation?: 'responding' | 'transcribing' | 'preparing' | null;
  materialId: string | null;
  archivedVersion: number | null;
}
export type ConversationSummary = Omit<Conversation, 'messages'> & { messageCount: number };
