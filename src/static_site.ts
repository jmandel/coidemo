import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { slugify } from './utils';

function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row: string[] = [];
    let cur = '';
    let inQuotes = false;
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        if (inQuotes && line[j+1] === '"') { cur += '"'; j++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        row.push(cur); cur='';
      } else {
        cur += ch;
      }
    }
    row.push(cur);
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => rec[h] = (row[idx] ?? '').trim());
    rows.push(rec);
  }
  return rows;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header>
    <h1>HL7 COI Public Register</h1>
    <nav><a href="./index.html">Home</a></nav>
  </header>
  <main>${body}</main>
  <footer><small>Generated ${new Date().toISOString()}</small></footer>
</body>
</html>`;
}

function personPage(p: Record<string,string>): string {
  const blocks = [
    ['HL7 role', p.hl7_role],
    ['Primary employer', p.primary_employer],
    ['Paid/governance roles', p.paid_governance_roles],
    ['Ownership (≥1%)', p.ownership_companies_1pct_plus],
    ['Intellectual property', p.ip_summary],
    ['Contracting entities', p.contracting_entities],
    ['Ultimate funders / sector:topic', p.ultimate_funders_or_sector_topic],
    ['Last updated', p.last_updated]
  ].map(([k,v]) => `<div class="field"><div class="k">${k}</div><div class="v">${(v||'').replace(/\n/g,'<br>')}</div></div>`).join('');

  return layout(`${p.name} – HL7 COI`, `
    <article>
      <h2>${p.name}</h2>
      ${blocks}
    </article>
  `);
}

function indexPage(rows: Record<string,string>[]): string {
  const cards = rows.map(r => `
    <a class="card" href="./${r.slug}.html">
      <div class="name">${r.name}</div>
      <div class="role">${r.hl7_role}</div>
      <div class="employer">${r.primary_employer}</div>
      <div class="updated">Updated: ${r.last_updated}</div>
    </a>
  `).join('');

  const body = `
  <section class="searchbar">
    <input id="q" type="search" placeholder="Search name, role, employer..." />
  </section>
  <section id="list" class="grid">${cards}</section>
  <script>
    const cards = Array.from(document.querySelectorAll('.card'));
    const q = document.getElementById('q');
    q.addEventListener('input', () => {
      const term = q.value.toLowerCase();
      for (const c of cards) {
        const txt = c.textContent.toLowerCase();
        c.style.display = txt.includes(term) ? '' : 'none';
      }
    });
  </script>
  `;
  return layout('Public Register', body);
}

export function generateStaticSiteFromCSV(csv: string, outDir = './public_site') {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const rows = parseCSV(csv);
  const indexHtml = indexPage(rows);
  writeFileSync(`${outDir}/index.html`, indexHtml, 'utf-8');
  writeFileSync(`${outDir}/styles.css`, `
    :root { font-family: system-ui, ui-sans-serif, Arial, sans-serif; }
    body { margin: 0; padding: 0 16px 40px; }
    header { display:flex; align-items:center; justify-content:space-between; padding: 12px 0; border-bottom:1px solid #ddd; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0; }
    main { max-width: 1000px; margin: 0 auto; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); gap: 12px; }
    .card { display:block; padding: 12px; border:1px solid #e3e3e3; border-radius:8px; text-decoration:none; color:inherit; }
    .card .name { font-weight:600; margin-bottom:4px; }
    .card .role, .card .employer, .card .updated { font-size: 12px; color:#555; }
    article { border:1px solid #e3e3e3; border-radius: 8px; padding: 16px; }
    article h2 { margin-top: 0; }
    .field { display:grid; grid-template-columns: 200px 1fr; gap: 8px; padding: 6px 0; border-bottom:1px dashed #eee; }
    .field .k { font-weight: 600; color:#333; }
    .searchbar { margin-bottom: 12px; }
    #q { width: 100%; padding: 10px; font-size: 14px; border:1px solid #ccc; border-radius: 6px; }
  `, 'utf-8');

  for (const r of rows) {
    const html = personPage(r);
    writeFileSync(`${outDir}/${r.slug}.html`, html, 'utf-8');
  }
}
