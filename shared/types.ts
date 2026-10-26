/** Compact tree-display summary. Canonical field-level provenance lives in ResearchClaim/ResearchArtifact. */
export type Provenance = 'told' | 'document' | 'hypothesis';

export type LifeEvent = {
  year?: number;
  approximate?: boolean;
  place?: string;
};

export type Person = {
  id: string;
  name: string;
  sex?: 'male' | 'female';
  birth?: LifeEvent;
  death?: LifeEvent;
  note?: string;
  provenance: Provenance;
  source?: string;
  createdAt: string;
};

export type Relation = {
  id: string;
  type: 'parent' | 'spouse';
  /** For 'parent': the parent. For 'spouse': either partner. */
  fromId: string;
  /** For 'parent': the child. */
  toId: string;
  provenance: Provenance;
  source?: string;
};

export type Tree = {
  people: Person[];
  relations: Relation[];
};

export type TreeState = Tree & { canUndo: boolean; lastChange?: string };

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  told: 'со слов',
  document: 'документ',
  hypothesis: 'гипотеза',
};

/** One candidate record found in an external source. Never a confirmed fact by itself. */
export type Finding = {
  source: string;
  name: string;
  birth?: string;
  event?: string;
  place?: string;
  kind?: string;
  url: string;
};

export type SearchResult = {
  source: string;
  query: string;
  searchUrl: string;
  total: number;
  searched?: number;
  shown: Finding[];
  note?: string;
};

export type SearchLink = { source: string; label: string; url: string; note?: string };

/** Evidence status is deliberately not a boolean truth flag. */
export type EvidenceStatus =
  | 'hypothesis'
  | 'single-source'
  | 'corroborated'
  | 'strongly-corroborated'
  | 'contradicted'
  | 'unresolved';

export type EvidenceConfidence = 'low' | 'moderate' | 'high';
export type LivingStatus = 'living' | 'deceased' | 'unknown';
export type CandidateStatus = 'candidate' | 'identified' | 'separate' | 'rejected';
export type ArtifactOriginality =
  | 'original'
  | 'image-of-original'
  | 'official-extract'
  | 'index'
  | 'transcription'
  | 'derivative'
  | 'user-statement'
  | 'unknown';
export type ArtifactDirectness = 'direct' | 'indirect' | 'negative' | 'lead-only';
export type ArtifactLegibility = 'clear' | 'partial' | 'poor' | 'unreadable' | 'not-applicable';
export type SearchResultStatus = 'found' | 'not-found-in-scope' | 'blocked' | 'unavailable' | 'incomplete' | 'error';

export type NameVariant = {
  asWritten: string;
  normalized?: string;
  languageScript?: string;
  rationale?: string;
  confidence?: EvidenceConfidence;
};

/** A candidate identity. Multiple candidates may share the same name. */
export type ResearchPerson = {
  id: string;
  treePersonId?: string;
  /** Retained only so undo can restore a projection link without guessing identity. */
  formerTreePersonId?: string;
  preferredLabel: string;
  livingStatus: LivingStatus;
  names: NameVariant[];
  birthEstimate?: string;
  deathEstimate?: string;
  placesAsWritten: string[];
  historicalJurisdictions: string[];
  candidateStatus: CandidateStatus;
  mergeOrSplitRationale?: string;
  sourceArtifactIds: string[];
  createdAt: string;
  updatedAt: string;
  notes?: string;
};

export type ResearchArtifact = {
  id: string;
  stableKey?: string;
  capturedAt: string;
  sourceTitle: string;
  sourceUrlOrPath?: string;
  sourceType: string;
  repositoryOrArchive?: string;
  archivalReference?: string;
  externalRecordId?: string;
  recordDateAsWritten?: string;
  placeAsWritten?: string;
  languageScript?: string;
  personIds: string[];
  namesAsWritten: string[];
  summary: string;
  rawFields?: Record<string, string>;
  provenanceLevel: 'known' | 'partial' | 'unknown';
  directness: ArtifactDirectness;
  originality: ArtifactOriginality;
  independenceGroup: string;
  legibility: ArtifactLegibility;
  accessNotes?: string;
  sha256?: string;
  relatedClaimIds: string[];
  reliabilityNotes?: string;
  status: 'captured' | 'analyzed' | 'superseded';
};

export type ResearchClaim = {
  id: string;
  claimText: string;
  subjectPersonIds: string[];
  claimType: string;
  valueAsWritten?: string;
  normalizedValue?: string;
  calendar?: 'Julian' | 'Gregorian' | 'unknown' | 'other';
  artifactIds: string[];
  supportingIndependenceGroups: string[];
  contradictingArtifactIds: string[];
  contradictsClaimIds: string[];
  status: EvidenceStatus;
  confidence: EvidenceConfidence;
  rationale: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipKind = 'parent' | 'spouse' | 'sibling' | 'guardian' | 'household' | 'other';
export type RelationshipBasis = 'biological' | 'legal' | 'adoptive' | 'step' | 'guardian' | 'household' | 'unknown';

export type ResearchRelationship = {
  id: string;
  /** Compact projection edge that produced this evidence entry, when applicable. */
  treeRelationId?: string;
  personAId: string;
  relationshipType: RelationshipKind;
  personBId: string;
  basis: RelationshipBasis;
  claimIds: string[];
  supportingArtifactIds: string[];
  contradictingArtifactIds: string[];
  independenceGroups: string[];
  status: EvidenceStatus;
  confidence: EvidenceConfidence;
  rationale: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchAttempt = {
  id: string;
  stableKey?: string;
  timestamp: string;
  targetPersonIds: string[];
  researchGoal: string;
  query: string;
  languageLocale?: string;
  sourceOrDomain: string;
  filters: Record<string, string>;
  resultStatus: SearchResultStatus;
  artifactIds: string[];
  resultCount?: number;
  searchedCount?: number;
  coverageNotes?: string;
  blocker?: string;
  captchaAttempts: 0;
  nextStep?: string;
};

export type ResearchCase = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  researchQuestion?: string;
  requestedOutputLanguage: 'auto' | string;
  scope: {
    targetRelationship?: string;
    timeRange?: string;
    geographicScope: string[];
    allowedSources: string[];
    prohibitedSources: string[];
    paidSourcesAllowed: boolean;
    thirdPartyUploadAllowed: boolean;
    contactWithPeopleOrArchivesAllowed: boolean;
  };
  privacy: {
    redactLivingPeopleInSharedReport: boolean;
    excludeCurrentContactsAndAddresses: boolean;
    sensitiveTopics: string[];
  };
  people: ResearchPerson[];
  artifacts: ResearchArtifact[];
  claims: ResearchClaim[];
  relationships: ResearchRelationship[];
  searches: SearchAttempt[];
};

export type EvidenceAudit = {
  counts: { people: number; artifacts: number; claims: number; relationships: number; searches: number };
  errors: string[];
  warnings: string[];
};
