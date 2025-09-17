import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DisclosureDocument, DisclosureDraft, DisclosureSnapshot, DisclosureRecord } from './disclosure_types';

export type PublicProfileSummary = {
  hl7_id: string;
  name: string;
  org_role: string;
  last_submitted_at: string | null;
  counts: {
    roles: number;
    financial: number;
    ownerships: number;
    gifts: number;
  };
  history_count: number;
};

export type User = {
  id: number;
  hl7_id: string;
  name: string;
  email: string;
  org_role: string;     // Board | Officer | Exec | TSC | ProductDirector | ProgramChair | CoChair
  is_admin: number;     // 0 or 1
  is_discloser: number; // 0 or 1
  created_at: string;
  updated_at: string;
};


export class DB {
  db: Database;

  constructor(path = './data/app.db') {
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL;`);
  }

  init() {
    const schema = readFileSync(`${import.meta.dir}/schema.sql`, 'utf-8');
    this.db.exec(schema);
  }

  nowISO() {
    return new Date().toISOString();
  }

  // --- Users ---
  getUserByOIDC(hl7_id: string): User | null {
    const stmt = this.db.query(`SELECT * FROM users WHERE hl7_id = ?`);
    const row = stmt.get(hl7_id) as User | undefined;
    return row ?? null;
  }

  getUserById(id: number): User | null {
    const stmt = this.db.query(`SELECT * FROM users WHERE id = ?`);
    const row = stmt.get(id) as User | undefined;
    return row ?? null;
  }

  createOrUpdateUser(u: Partial<User> & { hl7_id: string; name: string; email: string; org_role?: string }): User {
    const existing = this.getUserByOIDC(u.hl7_id);
    const now = this.nowISO();
    if (existing) {
      const name = u.name ?? existing.name;
      const email = u.email ?? existing.email;
      const org_role = u.org_role ?? existing.org_role;
      const stmt = this.db.prepare(`UPDATE users SET name=?, email=?, org_role=?, updated_at=? WHERE id=?`);
      stmt.run(name, email, org_role, now, existing.id);
      return { ...existing, name, email, org_role, updated_at: now };
    } else {
      const org_role = u.org_role ?? 'TSC';
      const is_admin = 0;
      const is_discloser = 1;
      const stmt = this.db.prepare(
        `INSERT INTO users (hl7_id, name, email, org_role, is_admin, is_discloser, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(u.hl7_id, u.name, u.email, org_role, is_admin, is_discloser, now, now);
      const id = this.db.query(`SELECT last_insert_rowid() as id`).get() as { id: number };
      return {
        id: id.id, hl7_id: u.hl7_id, name: u.name, email: u.email, org_role,
        is_admin, is_discloser, created_at: now, updated_at: now
      };
    }
  }

  setAdminByEmail(email: string) {
    const now = this.nowISO();
    const stmt = this.db.prepare(`UPDATE users SET is_admin=1, updated_at=? WHERE email=?`);
    stmt.run(now, email);
  }

  // --- Sessions ---
  createSession(user_id: number, session_id: string, expires_at_iso: string) {
    const now = this.nowISO();
    const stmt = this.db.prepare(
      `INSERT INTO sessions (session_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run(session_id, user_id, expires_at_iso, now);
  }

  getSession(session_id: string) {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
    return stmt.get(session_id) as { id: number; session_id: string; user_id: number; expires_at: string; created_at: string } | undefined;
  }

  deleteSession(session_id: string) {
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`);
    stmt.run(session_id);
  }

  // --- Disclosures ---
  getOrCreateDisclosureForUser(user_id: number): DisclosureRecord {
    const existing = this.db.query(`SELECT * FROM disclosures WHERE user_id = ?`).get(user_id) as any | undefined;
    if (existing) return this.deserializeDisclosure(existing);
    const now = this.nowISO();
    const stmt = this.db.prepare(`INSERT INTO disclosures (user_id, draft_json, draft_saved_at, history_json, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)`);
    stmt.run(user_id, null, null, now, now);
    const id = this.db.query(`SELECT last_insert_rowid() as id`).get() as { id: number };
    return {
      id: id.id,
      user_id,
      draft: null,
      history: [],
      last_submitted_at: null,
      created_at: now,
      updated_at: now
    };
  }

  listUsersWithStatus() {
    const sql = `
      SELECT u.id as user_id, u.name, u.email, u.org_role, u.is_admin,
             d.draft_json, d.draft_saved_at, d.history_json, d.last_submitted_at
      FROM users u
      LEFT JOIN disclosures d ON d.user_id = u.id
      WHERE u.is_discloser = 1
      ORDER BY u.name ASC
    `;
    const rows = this.db.query(sql).all() as any[];
    return rows.map((row) => {
      const draftDoc = row.draft_json ? (JSON.parse(row.draft_json) as DisclosureDocument) : null;
      const draftSavedAt = row.draft_saved_at as string | null;
      const history = row.history_json ? (JSON.parse(row.history_json) as DisclosureSnapshot[]) : [];
      const lastSubmitted = row.last_submitted_at as string | null;

      let status = 'Not Started';
      if (history.length === 0 && draftDoc && hasAnyEntry(draftDoc)) status = 'Draft';
      if (history.length > 0) status = 'Submitted';
      if (history.length > 0 && draftDoc && draftSavedAt && (!lastSubmitted || new Date(draftSavedAt) > new Date(lastSubmitted))) {
        status = 'Updated';
      }

      return {
        user_id: row.user_id,
        name: row.name,
        email: row.email,
        org_role: row.org_role,
        is_admin: row.is_admin,
        status,
        last_updated_ts: draftSavedAt ?? lastSubmitted ?? null
      };
    });
  }

  listPublicProfiles(): PublicProfileSummary[] {
    const sql = `
      SELECT u.id as user_id, u.hl7_id, u.name, u.org_role,
             d.history_json, d.last_submitted_at
      FROM users u
      LEFT JOIN disclosures d ON d.user_id = u.id
      WHERE u.is_discloser = 1
      ORDER BY u.name ASC
    `;
    const rows = this.db.query(sql).all() as any[];
    return rows.map((row) => {
      const history: DisclosureSnapshot[] = row.history_json ? JSON.parse(row.history_json) : [];
      const latest = history.length > 0 ? history[history.length - 1] : null;
      const counts = latest
        ? {
            roles: latest.document.roles.length,
            financial: latest.document.financial.length,
            ownerships: latest.document.ownerships.length,
            gifts: latest.document.gifts.length
          }
        : { roles: 0, financial: 0, ownerships: 0, gifts: 0 };
      return {
        hl7_id: row.hl7_id as string,
        name: row.name as string,
        org_role: row.org_role as string,
        last_submitted_at: row.last_submitted_at ?? null,
        counts,
        history_count: history.length
      } satisfies PublicProfileSummary;
    });
  }

  getDisclosure(disclosure_id: number): DisclosureRecord | null {
    const stmt = this.db.query(`SELECT * FROM disclosures WHERE id = ?`);
    const row = stmt.get(disclosure_id) as any | undefined;
    if (!row) return null;
    return this.deserializeDisclosure(row);
  }

  getDisclosureByUser(user_id: number): DisclosureRecord | null {
    const stmt = this.db.query(`SELECT * FROM disclosures WHERE user_id = ?`);
    const row = stmt.get(user_id) as any | undefined;
    if (!row) return null;
    return this.deserializeDisclosure(row);
  }

  saveDraft(disclosure_id: number, document: DisclosureDocument, savedAt?: string): DisclosureRecord {
    const timestamp = savedAt ?? this.nowISO();
    const stmt = this.db.prepare(`UPDATE disclosures SET draft_json=?, draft_saved_at=?, updated_at=? WHERE id=?`);
    stmt.run(JSON.stringify(document), timestamp, timestamp, disclosure_id);
    return this.getDisclosure(disclosure_id)!;
  }

  submitDraft(disclosure_id: number, submittedAt?: string): DisclosureRecord {
    const record = this.getDisclosure(disclosure_id);
    if (!record || !record.draft) return record ?? this.getDisclosure(disclosure_id)!;
    const now = submittedAt ?? this.nowISO();
    const snapshot: DisclosureSnapshot = {
      id: this.randomId(),
      submittedAt: now,
      document: record.draft.document
    };
    const history = [...record.history, snapshot];
    const stmt = this.db.prepare(`UPDATE disclosures SET history_json=?, last_submitted_at=?, updated_at=? WHERE id=?`);
    stmt.run(JSON.stringify(history), now, now, disclosure_id);
    return this.getDisclosure(disclosure_id)!;
  }

  private randomId() {
    return randomUUID().replace(/-/g, '');
  }

  private deserializeDisclosure(row: any): DisclosureRecord {
    return {
      id: row.id,
      user_id: row.user_id,
      draft: row.draft_json ? { savedAt: row.draft_saved_at, document: JSON.parse(row.draft_json) as DisclosureDocument } : null,
      history: row.history_json ? (JSON.parse(row.history_json) as DisclosureSnapshot[]) : [],
      last_submitted_at: row.last_submitted_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}

function hasAnyEntry(document: DisclosureDocument) {
  return (
    document.roles.length > 0 ||
    document.financial.length > 0 ||
    document.ownerships.length > 0 ||
    document.gifts.length > 0
  );
}
