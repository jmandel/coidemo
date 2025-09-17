import { Elysia } from 'elysia';
import { existsSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import homepage from '../frontend/index.html';
import { FHIRStore, type FHIRResource } from './db';
import { canonicalQuestionnaire, COI_CANONICAL_URL, COI_VERSION } from './questionnaire';
import { verifyAuthorization, type AuthenticatedAccessToken } from './auth';

const PORT = Number(process.env.PORT ?? 3000);
const allowedResourceTypes = new Set(['Questionnaire', 'QuestionnaireResponse']);
const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const MOCK_MODE = process.env.MOCK_AUTH === 'true';
const MOCK_OIDC_ISSUER = `${APP_BASE_URL}/mock-oidc`;

if (!existsSync('./data')) {
  mkdirSync('./data', { recursive: true });
}

const dbPath = process.env.FHIR_DB_PATH ?? './data/fhir.db';
const store = new FHIRStore(dbPath);
store.init();
seedCanonicalQuestionnaire(store);

const app = new Elysia();

if (MOCK_MODE) {
  registerMockOidc(app);
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
  const bundle: FHIRResource = {
    resourceType: 'Bundle',
    type: 'searchset',
    total: result.total,
    entry: result.resources.map((resource) => ({ resource })),
    link: [
      {
        relation: 'self',
        url: absoluteUrl
      }
    ],
    extension: [
      {
        url: 'https://hl7.org/fhir/StructureDefinition/bundle-total-accurate',
        valueBoolean: true
      }
    ]
  } as unknown as FHIRResource;

  const page = searchParams.get('_page');
  const count = searchParams.get('_count');
  bundle['meta'] = {
    tag: [
      { system: 'https://example.org/fhir/_page', code: page ?? '1' },
      { system: 'https://example.org/fhir/_count', code: count ?? String(result.limit) }
    ]
  };
  return bundle;
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
    oidcIssuer: MOCK_MODE ? MOCK_OIDC_ISSUER : process.env.OIDC_ISSUER ?? null,
    oidcClientId: MOCK_MODE ? (process.env.OIDC_CLIENT_ID ?? 'mock-client') : process.env.OIDC_CLIENT_ID ?? null,
    oidcRedirectUri: process.env.OIDC_REDIRECT_URI ?? `${APP_BASE_URL}/`,
    mockAuth: MOCK_MODE,
    questionnaire: {
      url: COI_CANONICAL_URL,
      version: COI_VERSION
    }
  };
}

type MockCodePayload = {
  claims: Record<string, unknown>;
  issuedAt: number;
  redirectUri: string;
  clientId?: string | null;
  scope?: string | null;
};

function registerMockOidc(app: Elysia) {
  const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  app.get('/mock-oidc/.well-known/openid-configuration', () => {
    const metadata = {
      issuer: MOCK_OIDC_ISSUER,
      authorization_endpoint: `${MOCK_OIDC_ISSUER}/authorize`,
      token_endpoint: `${MOCK_OIDC_ISSUER}/token`,
      jwks_uri: `${MOCK_OIDC_ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['none'],
      scopes_supported: ['openid', 'profile', 'email'],
      token_endpoint_auth_methods_supported: ['none']
    };
    return new Response(JSON.stringify(metadata), { status: 200, headers: jsonHeaders });
  });

  app.get('/mock-oidc/jwks', () => {
    return new Response(JSON.stringify({ keys: [] }), { status: 200, headers: jsonHeaders });
  });

  app.get('/mock-oidc/authorize', ({ request }) => {
    const url = new URL(request.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    if (!redirectUri) {
      return new Response('missing redirect_uri', { status: 400 });
    }
    const state = url.searchParams.get('state');
    const claims = decodeMockClaims(url.searchParams.get('mock_jwk_claims'));
    const payload: MockCodePayload = {
      claims,
      issuedAt: Date.now(),
      redirectUri,
      clientId: url.searchParams.get('client_id'),
      scope: url.searchParams.get('scope')
    };
    const code = base64UrlEncodeString(JSON.stringify(payload));
    const location = appendAuthParams(redirectUri, code, state);
    return new Response(null, {
      status: 302,
      headers: { Location: location }
    });
  });

  app.post('/mock-oidc/token', async ({ request }) => {
    const body = await request.text();
    const form = new URLSearchParams(body);
    const codeParam = form.get('code');
    if (!codeParam) {
      return new Response('invalid_grant', { status: 400 });
    }
    const payload = decodeCodePayload(codeParam);
    if (!payload) {
      return new Response('invalid_grant', { status: 400 });
    }
    const clientId = form.get('client_id') ?? payload.clientId ?? process.env.OIDC_CLIENT_ID ?? 'mock-client';
    const scope = form.get('scope') ?? payload.scope ?? 'openid profile email';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims = materializeClaims(payload.claims);
    const tokenClaims = {
      ...claims,
      iss: MOCK_OIDC_ISSUER,
      aud: clientId,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    };
    const encodedPayload = base64UrlEncodeString(JSON.stringify(tokenClaims));
    const accessToken = encodedPayload;
    const idToken = `eyJhbGciOiJub25lIn0.${encodedPayload}.`;
    const responseBody = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
      id_token: idToken
    };
    return new Response(JSON.stringify(responseBody), { status: 200, headers: jsonHeaders });
  });
}

function appendAuthParams(redirectUri: string, code: string, state: string | null): string {
  try {
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return url.toString();
  } catch {
    const params = new URLSearchParams();
    params.set('code', code);
    if (state) params.set('state', state);
    const separator = redirectUri.includes('?') ? '&' : '?';
    return `${redirectUri}${separator}${params.toString()}`;
  }
}

function decodeMockClaims(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return { sub: 'mock-user', name: 'Mock User' };
  }
  try {
    const json = base64UrlDecodeString(raw);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return { sub: 'mock-user', name: 'Mock User' };
}

function decodeCodePayload(code: string): MockCodePayload | null {
  try {
    const json = base64UrlDecodeString(code);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const claims = obj.claims && typeof obj.claims === 'object' && !Array.isArray(obj.claims)
      ? (obj.claims as Record<string, unknown>)
      : {};
    const redirectUri = typeof obj.redirectUri === 'string' ? obj.redirectUri : '';
    const issuedAt = typeof obj.issuedAt === 'number' ? obj.issuedAt : Date.now();
    const clientId = typeof obj.clientId === 'string' ? obj.clientId : null;
    const scope = typeof obj.scope === 'string' ? obj.scope : null;
    return { claims, issuedAt, redirectUri, clientId, scope };
  } catch {
    return null;
  }
}

function materializeClaims(raw: Record<string, unknown>): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const claims = { sub: 'mock-user', name: 'Mock User', ...base } as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || !claims.sub) claims.sub = 'mock-user';
  if (typeof claims.name !== 'string' || !claims.name) claims.name = 'Mock User';
  return claims;
}

function base64UrlEncodeString(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeString(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf-8');
}
