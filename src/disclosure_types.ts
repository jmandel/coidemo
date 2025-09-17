export type EntityType = 'for_profit' | 'nonprofit' | 'government' | 'university' | 'public' | 'private' | 'llc' | 'other';

export interface ParticipantInfo {
  name: string;
  email: string;
  hl7Roles: string[];
  consentPublic: boolean;
}

export interface RoleDisclosure {
  entityName: string;
  entityType: EntityType;
  role: string;
  paid: boolean;
  primaryEmployer: boolean;
  aboveThreshold: boolean | null;
}

export interface FinancialDisclosure {
  fundingSource: string;
  entityType: EntityType;
  passThrough: boolean;
  intermediary: string;
}

export interface OwnershipDisclosure {
  entityName: string;
  entityType: EntityType;
  tier: '1-5%' | '>5%';
}

export interface GiftDisclosure {
  sponsor: string;
  entityType: EntityType;
}

export interface DisclosureDocument {
  recordYear: number;
  participant: ParticipantInfo;
  roles: RoleDisclosure[];
  financial: FinancialDisclosure[];
  ownerships: OwnershipDisclosure[];
  gifts: GiftDisclosure[];
  certificationChecked: boolean;
}

export interface DisclosureDraft {
  savedAt: string;
  document: DisclosureDocument;
}

export interface DisclosureSnapshot {
  id: string;
  submittedAt: string;
  document: DisclosureDocument;
}

export interface DisclosureRecord {
  id: number;
  user_id: number;
  draft: DisclosureDraft | null;
  history: DisclosureSnapshot[];
  last_submitted_at: string | null;
  created_at: string;
  updated_at: string;
}
