import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type FHIRResource = {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
};

export type FHIRSearchResult = {
  resources: FHIRResource[];
  total: number;
  limit: number;
  page: number;
};

export class FHIRStore {
  private db: Database;

  constructor(path = './data/fhir.db') {
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL;`);
  }

  init() {
    const schema = readFileSync(`${import.meta.dir}/schema.sql`, 'utf-8');
    this.db.exec(schema);
  }

  create(resource: FHIRResource): FHIRResource {
    const id = (resource.id && String(resource.id)) || this.generateId();
    const payload = { ...resource, id };
    const json = JSON.stringify(payload);
    const stmt = this.db.prepare(`INSERT INTO resources (id, json) VALUES (?, ?)`);
    stmt.run(id, json);
    return payload;
  }

  replace(resourceType: string, id: string, resource: FHIRResource): { resource: FHIRResource; created: boolean } {
    const payload = { ...resource, resourceType, id } as FHIRResource;
    const json = JSON.stringify(payload);
    const exists = this.db.query(`SELECT 1 FROM resources WHERE id = ?`).get(id) as { 1: 1 } | undefined;
    if (exists) {
      const stmt = this.db.prepare(`UPDATE resources SET json = ? WHERE id = ?`);
      stmt.run(json, id);
      return { resource: payload, created: false };
    }
    const stmt = this.db.prepare(`INSERT INTO resources (id, json) VALUES (?, ?)`);
    stmt.run(id, json);
    return { resource: payload, created: true };
  }

  get(resourceType: string, id: string): FHIRResource | null {
    const row = this.db.query(`SELECT json FROM resources WHERE id = ?`).get(id) as { json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.json) as FHIRResource;
    if (parsed.resourceType !== resourceType) return null;
    return parsed;
  }

  search(resourceType: string, params: URLSearchParams): FHIRSearchResult {
    const where = [`json_extract(json, '$.resourceType') = ?`];
    const args: any[] = [resourceType];

    const status = params.get('status');
    if (status) {
      where.push(`json_extract(json, '$.status') = ?`);
      args.push(status);
    }

    if (resourceType === 'Questionnaire') {
      const url = params.get('url');
      if (url) {
        where.push(`json_extract(json, '$.url') = ?`);
        args.push(url);
      }
      const version = params.get('version');
      if (version) {
        where.push(`json_extract(json, '$.version') = ?`);
        args.push(version);
      }
      const idFilter = params.get('_id');
      if (idFilter) {
        where.push(`id = ?`);
        args.push(idFilter);
      }
    }

    if (resourceType === 'QuestionnaireResponse') {
      const subjectIdentifiers = params.getAll('subject:identifier');
      if (subjectIdentifiers.length > 0) {
        const clauses: string[] = [];
        for (const raw of subjectIdentifiers) {
          if (!raw) continue;
          const parts = raw.split('|');
          let system: string | null = null;
          let value: string | null = null;
          if (parts.length > 1) {
            system = parts[0] || null;
            value = parts.slice(1).join('|') || null;
          } else {
            value = raw;
          }
          if (system) {
            clauses.push(`(json_extract(json, '$.subject.identifier.system') = ? AND json_extract(json, '$.subject.identifier.value') = ?)`);
            args.push(system, value ?? '');
          } else {
            clauses.push(`json_extract(json, '$.subject.identifier.value') = ?`);
            args.push(value ?? '');
          }
        }
        if (clauses.length > 0) {
          where.push(`(${clauses.join(' OR ')})`);
        }
      }

      const questionnaire = params.get('questionnaire');
      if (questionnaire) {
        if (questionnaire.includes('|')) {
          where.push(`json_extract(json, '$.questionnaire') = ?`);
          args.push(questionnaire);
        } else {
          where.push(`(json_extract(json, '$.questionnaire') = ? OR json_extract(json, '$.questionnaire') LIKE ? || '|%')`);
          args.push(questionnaire, questionnaire);
        }
      }

      const authoredFilters = params.getAll('authored');
      for (const raw of authoredFilters) {
        if (!raw) continue;
        const { op, value } = parseDatePrefix(raw);
        where.push(`json_extract(json, '$.authored') ${op} ?`);
        args.push(value);
      }
    }

    const limit = clampCount(params.get('_count'));
    const page = clampPage(params.get('_page'));
    const offset = (page - 1) * limit;

    const whereSql = where.join(' AND ');
    const dataStmt = this.db.prepare(`
      SELECT json FROM resources
      WHERE ${whereSql}
      LIMIT ? OFFSET ?
    `);
    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM resources
      WHERE ${whereSql}
    `);

    const rows = dataStmt.all(...([...args, limit, offset] as any[])) as { json: string }[];
    const totalRow = totalStmt.get(...(args as any[])) as { cnt: number } | undefined;
    const resources = rows.map((row) => JSON.parse(row.json) as FHIRResource);

    return {
      resources,
      total: totalRow?.cnt ?? 0,
      limit,
      page
    };
  }

  private generateId(): string {
    return randomUUID().replace(/-/g, '');
  }
}

function clampCount(raw: string | null): number {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(1, Math.floor(parsed)), 200);
}

function clampPage(raw: string | null): number {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

function parseDatePrefix(raw: string): { op: string; value: string } {
  const prefixes: Record<string, string> = {
    ge: '>=',
    gt: '>',
    le: '<=',
    lt: '<'
  };
  const prefix = raw.slice(0, 2);
  const op = prefixes[prefix];
  if (op) {
    return { op, value: raw.slice(2) };
  }
  return { op: '=', value: raw };
}
