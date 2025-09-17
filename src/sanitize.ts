import type { DB } from './db';
import { slugify } from './utils';
import type { DisclosureDocument, DisclosureRecord } from './disclosure_types';

export type PublicRow = {
  name: string;
  hl7_role: string;
  primary_employer: string;
  paid_governance_roles: string; // '; ' separated
  ownership_companies_1pct_plus: string; // '; ' separated
  ip_summary: string; // '; ' separated
  contracting_entities: string; // '; ' separated
  ultimate_funders_or_sector_topic: string; // '; ' separated
  last_updated: string;
  slug: string;
};

export function buildPublicRows(db: DB): PublicRow[] {
  const users = db.listUsersWithStatus();
  const rows: PublicRow[] = [];

  for (const u of users) {
    const record = db.getDisclosureByUser(u.user_id);
    if (!record) continue;

    const latestDoc = getLatestDocument(record);
    if (!latestDoc) continue;

    const employments = latestDoc.roles;
    const primaryEmp = employments.find(e => e.primaryEmployer) ?? employments[0];
    const primary_employer = primaryEmp?.entityName ?? '';
    const rolesList = employments.map(e => {
      const role = e.role ? ` (${e.role})` : '';
      return `${e.entityName}${role}`.trim();
    }).filter(Boolean);

    const ownerships = latestDoc.ownerships;
    const ownershipCompanies = ownerships.map(e => `${e.entityName} (${e.tier})`).filter(Boolean);

    const ipSummary: string[] = []; // IP captured elsewhere? (not in new data) maybe part of roles? if not, leave blank

    const comps = latestDoc.financial;
    const contracting = comps.filter(e => e.passThrough && e.intermediary).map(e => e.intermediary ?? '').filter(Boolean);
    const ultimate = comps.map(e => {
      if (e.passThrough && e.intermediary) {
        return `${e.fundingSource} via ${e.intermediary}`;
      }
      return e.fundingSource;
    }).filter(Boolean);

    const lastUpdated = record.last_submitted_at ?? record.draft?.savedAt ?? record.updated_at;

    const row: PublicRow = {
      name: u.name,
      hl7_role: u.org_role,
      primary_employer,
      paid_governance_roles: rolesList.join('; '),
      ownership_companies_1pct_plus: ownershipCompanies.join('; '),
      ip_summary: ipSummary.join('; '),
      contracting_entities: contracting.join('; '),
      ultimate_funders_or_sector_topic: ultimate.join('; '),
      last_updated: lastUpdated,
      slug: slugify(u.name)
    };
    rows.push(row);
  }

  return rows;
}

function getLatestDocument(record: DisclosureRecord | null): DisclosureDocument | null {
  if (!record) return null;
  if (record.history.length > 0) {
    return record.history[record.history.length - 1].document;
  }
  return record.draft?.document ?? null;
}

// CSV helpers (quote if necessary)
function csvEscape(s: string) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCSV(rows: PublicRow[]): string {
  const header = [
    'name','hl7_role','primary_employer','paid_governance_roles','ownership_companies_1pct_plus',
    'ip_summary','contracting_entities','ultimate_funders_or_sector_topic','last_updated','slug'
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const vals = [
      r.name, r.hl7_role, r.primary_employer, r.paid_governance_roles, r.ownership_companies_1pct_plus,
      r.ip_summary, r.contracting_entities, r.ultimate_funders_or_sector_topic, r.last_updated, r.slug
    ].map(csvEscape);
    lines.push(vals.join(','));
  }
  return lines.join('\n') + '\n';
}
