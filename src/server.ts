import { Elysia } from 'elysia';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DB } from './db';
import { randomId } from './utils';
import { handleLoginRedirect, handleCallback } from './auth';
import { buildPublicRows, toCSV } from './sanitize';
import { generateStaticSiteFromCSV } from './static_site';
import homepage from '../frontend/index.html';
import type { DisclosureDocument } from './disclosure_types';

const PORT = Number(process.env.PORT ?? 3000);
const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const MOCK_AUTH = process.env.MOCK_AUTH === 'true';
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';

const dbInstance = new DB();
dbInstance.init();
if (!existsSync('./data')) mkdirSync('./data', { recursive: true });
if (!existsSync('./public_site')) mkdirSync('./public_site', { recursive: true });

const app = new Elysia().state('db', dbInstance);

app.onError((ctx) => {
  console.error('Request error', ctx.code, ctx.error);
  if (ctx.error instanceof Response) return ctx.error;
  const status = typeof (ctx.error as any)?.status === 'number' ? (ctx.error as any).status : ctx.set.status ?? 500;
  return new Response('Internal Server Error', { status });
});

function requireAuth(ctx: any) {
  const sidCookie = ctx.cookie?.sid;
  const sid = sidCookie?.value;
  if (!sid) return null;
  const s = ctx.store.db.getSession(sid);
  if (!s) return null;
  const user = ctx.store.db.getUserById(s.user_id);
  return user;
}

function requireAdmin(ctx: any) {
  const u = requireAuth(ctx);
  if (!u || u.is_admin !== 1) return null;
  return u;
}

function summarizeDocument(doc: DisclosureDocument) {
  return {
    roles: doc.roles.length,
    financial: doc.financial.length,
    ownerships: doc.ownerships.length,
    gifts: doc.gifts.length
  };
}

function finalizeLogin(db: DB, cookieJar: any, set: any, user: any) {
  const sid = randomId(24);
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
  db.createSession(user.id, sid, expires.toISOString());
  cookieJar.sid.set({
    value: sid,
    maxAge: 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    path: '/'
  });
  set.headers['Location'] = '/';
  return new Response(null, { status: 302 });
}

// Health
app.get('/health', () => ({ ok: true }));

app.get('/api/meta', () => ({ mockAuth: MOCK_AUTH }));

// OIDC
app.get('/auth/login', async (ctx) => {
  const { set, store, request, cookie } = ctx;
  if (MOCK_AUTH) {
    const params = new URL(request.url).searchParams;
    const email = params.get('email');
    if (!email) {
      return new Response('Mock auth enabled. Use /auth/login?email=someone@example.org to choose a user.', { status: 400 });
    }
    const name = params.get('name') ?? email;
    const hl7_id = params.get('hl7_id') ?? `mock|${email}`;
    const org_role = params.get('org_role') ?? undefined;
    const is_admin = params.get('admin') === 'true';

    const user = store.db.createOrUpdateUser({ hl7_id, name, email, org_role: org_role as any });
    if (is_admin) store.db.setAdminByEmail(email);
    const refreshed = is_admin ? store.db.getUserById(user.id) ?? user : user;
    return finalizeLogin(store.db, cookie, set, refreshed);
  }

  const { url, cookieValue } = await handleLoginRedirect(APP_BASE_URL);
  set.headers['Location'] = url;
  // short-lived cookie for OIDC state
  cookie.oidc.set({
    value: cookieValue,
    maxAge: 600,
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    path: '/'
  });
  return new Response(null, { status: 302 });
});

app.get('/auth/callback', async ({ request, store, set, cookie }) => {
  if (MOCK_AUTH) {
    return new Response('Mock auth enabled; hit /auth/login?email=example@org to create a session.', { status: 400 });
  }

  const url = new URL(request.url);
  try {
    const oidcState = cookie?.oidc?.value ?? null;
    const user = await handleCallback(store.db, url.searchParams, oidcState);
    // Only allow users that are marked as disclosers (seeded beforehand)
    if (user.is_discloser !== 1) {
      return new Response('Not authorized (not in discloser cohort). Contact admin.', { status: 403 });
    }
    cookie.oidc.remove();
    return finalizeLogin(store.db, cookie, set, user);
  } catch (e) {
    console.error(e);
    return new Response('Authentication error', { status: 400 });
  }
});

app.get('/auth/logout', ({ cookie, store }) => {
  const sid = cookie?.sid?.value;
  if (sid) store.db.deleteSession(sid);
  cookie.sid.remove();
  return new Response(null, { status: 204 });
});

// Current user
app.get('/api/me', ({ cookie, store }) => {
  const user = requireAuth({ cookie, store });
  if (!user) return new Response('Unauthorized', { status: 401 });
  const record = store.db.getDisclosureByUser(user.id) ?? store.db.getOrCreateDisclosureForUser(user.id);
  return { user, disclosure: record };
});

// Get disclosure (with items)
app.get('/api/disclosure', ({ cookie, store }) => {
  const user = requireAuth({ cookie, store });
  if (!user) return new Response('Unauthorized', { status: 401 });
  const record = store.db.getOrCreateDisclosureForUser(user.id);
  return { disclosure: record };
});

// Update disclosure items (auto-save)
app.put('/api/disclosure', async ({ cookie, store, request }) => {
  const user = requireAuth({ cookie, store });
  if (!user) return new Response('Unauthorized', { status: 401 });
  const record = store.db.getOrCreateDisclosureForUser(user.id);
  const body = await request.json();
  if (!body || typeof body !== 'object' || !body.document) return new Response('Invalid payload', { status: 400 });
  const updated = store.db.saveDraft(record.id, body.document);
  return { ok: true, disclosure: updated };
});

// Submit disclosure
app.post('/api/disclosure/submit', ({ cookie, store }) => {
  const user = requireAuth({ cookie, store });
  if (!user) return new Response('Unauthorized', { status: 401 });
  const record = store.db.getOrCreateDisclosureForUser(user.id);
  const updated = store.db.submitDraft(record.id);
  return { ok: true, disclosure: updated };
});

// Admin: list disclosers
app.get('/api/admin/disclosers', ({ cookie, store }) => {
  const admin = requireAdmin({ cookie, store });
  if (!admin) return new Response('Forbidden', { status: 403 });
  const rows = store.db.listUsersWithStatus();
  return { disclosers: rows };
});

// Admin: view a user's disclosure
app.get('/api/admin/disclosures/:userId', ({ cookie, store, params }) => {
  const admin = requireAdmin({ cookie, store });
  if (!admin) return new Response('Forbidden', { status: 403 });
  const uid = Number(params.userId);
  const record = store.db.getDisclosureByUser(uid);
  if (!record) return { disclosure: null };
  return { disclosure: record };
});

// Admin: generate public report (returns CSV download and generates static site)
app.post('/api/admin/generate-public-report', async ({ cookie, store, set }) => {
  const admin = requireAdmin({ cookie, store });
  if (!admin) return new Response('Forbidden', { status: 403 });

  const rows = buildPublicRows(store.db);
  const csv = toCSV(rows);
  const csvPath = './public_disclosures.csv';
  writeFileSync(csvPath, csv, 'utf-8');

  // Also generate static site from CSV
  generateStaticSiteFromCSV(csv, './public_site');

  set.headers['Content-Type'] = 'text/csv; charset=utf-8';
  set.headers['Content-Disposition'] = 'attachment; filename="public_disclosures.csv"';
      return new Response(csv);
});

// Public APIs
app.get('/api/public/disclosers', ({ store }) => {
  const profiles = store.db.listPublicProfiles();
  return { profiles };
});

app.get('/api/public/disclosures/:hl7Id', ({ store, params }) => {
  const hl7Id = decodeURIComponent(params.hl7Id);
  const user = store.db.getUserByOIDC(hl7Id);
  if (!user) return new Response('Not Found', { status: 404 });
  const record = store.db.getDisclosureByUser(user.id);
  if (!record || record.history.length === 0) {
    return {
      user: { hl7_id: user.hl7_id, name: user.name, org_role: user.org_role },
      latest: null,
      history: []
    };
  }
  const history = record.history.map((snap) => ({
    id: snap.id,
    submittedAt: snap.submittedAt,
    counts: summarizeDocument(snap.document)
  }));
  const latest = record.history[record.history.length - 1];
  return {
    user: { hl7_id: user.hl7_id, name: user.name, org_role: user.org_role },
    latest: { submittedAt: latest.submittedAt, document: latest.document, counts: summarizeDocument(latest.document) },
    history
  };
});

app.get('/api/public/disclosures/:hl7Id/:timestamp', ({ store, params }) => {
  const hl7Id = decodeURIComponent(params.hl7Id);
  const timestamp = decodeURIComponent(params.timestamp);
  const user = store.db.getUserByOIDC(hl7Id);
  if (!user) return new Response('Not Found', { status: 404 });
  const record = store.db.getDisclosureByUser(user.id);
  if (!record) return new Response('Not Found', { status: 404 });
  const match = record.history.find((snap) => snap.submittedAt === timestamp || snap.id === timestamp);
  if (!match) return new Response('Not Found', { status: 404 });
  return {
    user: { hl7_id: user.hl7_id, name: user.name, org_role: user.org_role },
    submission: { submittedAt: match.submittedAt, document: match.document, counts: summarizeDocument(match.document) }
  };
});

const spaRoutes = ['/', '/form', '/form/*', '/admin', '/admin/*', '/public', '/public/*'];
const routes: Record<string, Response> = {};
for (const path of spaRoutes) routes[path] = homepage;

const server = Bun.serve({
  port: PORT,
  routes,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth') || url.pathname.startsWith('/health')) {
      return app.handle(req);
    }

    if (url.pathname.startsWith('/public_site')) {
      const file = Bun.file(`.${url.pathname}`);
      if (await file.exists()) return new Response(file);
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/public_disclosures.csv') {
      const file = Bun.file('./public_disclosures.csv');
      if (await file.exists()) return new Response(file);
      return new Response('Not Found', { status: 404 });
    }

    return app.handle(req);
  }
});

console.log(`COI portal running at ${APP_BASE_URL}`);
