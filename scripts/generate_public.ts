import { DB } from '../src/db';
import { buildPublicRows, toCSV } from '../src/sanitize';
import { generateStaticSiteFromCSV } from '../src/static_site';
import { writeFileSync } from 'node:fs';

const db = new DB();
db.init();

const rows = buildPublicRows(db);
const csv = toCSV(rows);
writeFileSync('./public_disclosures.csv', csv, 'utf-8');
generateStaticSiteFromCSV(csv, './public_site');

console.log('Generated ./public_disclosures.csv and ./public_site/');
