import { Elysia } from 'elysia';
import { existsSync, mkdirSync } from 'node:fs';
import homepage from '../frontend/index.html';
import { FHIRStore, type FHIRResource } from './db';
import { canonicalQuestionnaire, COI_CANONICAL_URL, COI_VERSION } from './questionnaire';
import { verifyAuthorization, type AuthenticatedAccessToken } from './auth';
import { registerMockOidc } from './mock_oidc';

const PORT = Number(process.env.PORT ?? 3000);
const allowedResourceTypes = new Set(['Questionnaire', 'QuestionnaireResponse']);
const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const MOCK_MODE = process.env.MOCK_AUTH === 'true';
const MOCK_OIDC_BASE_PATH = '/mock-oidc';
const MOCK_OIDC_ISSUER = `${APP_BASE_URL}${MOCK_OIDC_BASE_PATH}`;

if (MOCK_MODE) {
  process.env.OIDC_ISSUER = MOCK_OIDC_ISSUER;
  process.env.OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'mock-client';
  process.env.OIDC_AUDIENCE = process.env.OIDC_CLIENT_ID;
}

if (!existsSync('./data')) {
  mkdirSync('./data', { recursive: true });
}

const dbPath = process.env.FHIR_DB_PATH ?? './data/fhir.db';
const store = new FHIRStore(dbPath);
store.init();
seedCanonicalQuestionnaire(store);

const app = new Elysia();

if (MOCK_MODE) {
  registerMockOidc(app, {
    basePath: MOCK_OIDC_BASE_PATH,
    issuer: process.env.OIDC_ISSUER ?? MOCK_OIDC_ISSUER,
    defaultClientId: process.env.OIDC_CLIENT_ID ?? 'mock-client'
  });
}

app.get('/health', () => ({ ok: true }));

app.get('/fhir/:type', async ({ params, request }) => {
  const type = params.type;
  if (!allowedResourceTypes.has(type)) {
    return new Response('Not Found', { status: 404 });
  }
  const auth = await verifyAuthorization(request.headers.get('authorization'));
  if (!auth) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const result = store.search(type, url.searchParams);
  const bundle = toBundle(result, url.searchParams, request.url);
  const headers = new Headers({ 'Content-Type': 'application/fhir+json' });
  return new Response(JSON.stringify(bundle), { status: 200, headers });
});

app.get('/fhir/:type/:id', async ({ params, request }) => {
  const type = params.type;
  if (!allowedResourceTypes.has(type)) {
    return new Response('Not Found', { status: 404 });
  }
  const auth = await verifyAuthorization(request.headers.get('authorization'));
  if (!auth) {
    return new Response('Unauthorized', { status: 401 });
  }
  const resource = store.get(type, params.id);
  if (!resource) {
    return new Response('Not Found', { status: 404 });
  }
  const headers = new Headers({ 'Content-Type': 'application/fhir+json' });
  return new Response(JSON.stringify(resource), { status: 200, headers });
});

app.post('/fhir/:type', async ({ params, request }) => {
  const type = params.type;
  if (!allowedResourceTypes.has(type)) {
    return new Response('Not Found', { status: 404 });
  }
  const auth = await verifyAuthorization(request.headers.get('authorization'));
  if (!auth) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await safeJson(request)) as FHIRResource | null;
  if (!body || typeof body !== 'object') {
    return new Response('Invalid body', { status: 400 });
  }
  if (body.resourceType !== type) {
    return new Response('resourceType mismatch', { status: 400 });
  }
  if (type === 'QuestionnaireResponse') {
    const error = enforceQuestionnaireResponseInvariants(body, auth);
    if (error) {
      return new Response(error, { status: 400 });
    }
  }
  const created = store.create(body);
  const headers = new Headers({
    'Content-Type': 'application/fhir+json',
    Location: `/fhir/${type}/${created.id}`
  });
  return new Response(JSON.stringify(created), {
    status: 201,
    headers
  });
});

app.put('/fhir/:type/:id', async ({ params, request }) => {
  const type = params.type;
  if (!allowedResourceTypes.has(type)) {
    return new Response('Not Found', { status: 404 });
  }
  const auth = await verifyAuthorization(request.headers.get('authorization'));
  if (!auth) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await safeJson(request)) as FHIRResource | null;
  if (!body || typeof body !== 'object') {
    return new Response('Invalid body', { status: 400 });
  }
  if (body.resourceType !== type) {
    return new Response('resourceType mismatch', { status: 400 });
  }
  if (type === 'QuestionnaireResponse') {
    const error = enforceQuestionnaireResponseInvariants(body, auth);
    if (error) {
      return new Response(error, { status: 400 });
    }
  }
  const result = store.replace(type, params.id, body);
  const headers = new Headers({ 'Content-Type': 'application/fhir+json' });
  if (result.created) {
    headers.set('Location', `/fhir/${type}/${params.id}`);
    return new Response(JSON.stringify(result.resource), {
      status: 201,
      headers
    });
  }
  return new Response(JSON.stringify(result.resource), { status: 200, headers });
});

const spaRoutes = ['/', '/form', '/form/*', '/public', '/public/*'];
const routes: Record<string, Response> = {} as Record<string, Response>;
for (const path of spaRoutes) routes[path] = homepage as unknown as Response;

const server = Bun.serve({
  port: PORT,
  routes,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/fhir') || url.pathname === '/health') {
      return app.handle(req);
    }
    if (url.pathname === '/config.json') {
      return configJsonResponse();
    }
    if (url.pathname === '/config.js') {
      return configResponse();
    }
    return app.handle(req);
  }
});

console.log(`FHIR COI server running at http://localhost:${PORT}`);

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function enforceQuestionnaireResponseInvariants(resource: FHIRResource, auth: AuthenticatedAccessToken): string | null {
  if (!resource.subject || typeof resource.subject !== 'object') {
    resource.subject = {};
  }
  const subject = resource.subject as Record<string, unknown>;
  const identifier = (subject.identifier && typeof subject.identifier === 'object'
    ? subject.identifier as Record<string, unknown>
    : {});

  identifier.system = auth.subjectSystem;
  identifier.value = auth.subjectValue;
  subject.identifier = identifier;
  if (!subject.display && auth.display) {
    subject.display = auth.display;
  }
  resource.subject = subject;

  if (!resource.questionnaire) {
    return 'QuestionnaireResponse.questionnaire is required';
  }
  if (!resource.status) {
    return 'QuestionnaireResponse.status is required';
  }
  return null;
}

function seedCanonicalQuestionnaire(store: FHIRStore) {
  const params = new URLSearchParams();
  params.set('url', COI_CANONICAL_URL);
  params.set('version', COI_VERSION);
  const existing = store.search('Questionnaire', params);
  if (existing.total > 0) return;
  store.create(canonicalQuestionnaire);
}

function toBundle(result: ReturnType<FHIRStore['search']>, searchParams: URLSearchParams, absoluteUrl: string) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: result.total,
    link: [
      {
        relation: 'self',
        url: absoluteUrl
      }
    ],
    entry: result.resources.map((resource) => ({ resource }))
  } satisfies FHIRResource;
}

function configResponse() {
  const config = currentConfig();
  const body = `window.__APP_CONFIG = ${JSON.stringify(config)};`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function configJsonResponse() {
  const config = currentConfig();
  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function currentConfig() {
  return {
    fhirBaseUrl: `${APP_BASE_URL}/fhir`,
    oidcIssuer: process.env.OIDC_ISSUER ?? null,
    oidcClientId: process.env.OIDC_CLIENT_ID ?? null,
    oidcRedirectUri: process.env.OIDC_REDIRECT_URI ?? `${APP_BASE_URL}/`,
    mockAuth: MOCK_MODE,
    questionnaire: {
      url: COI_CANONICAL_URL,
      version: COI_VERSION
    }
  };
}
