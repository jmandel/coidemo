export type AppConfig = {
  fhirBaseUrl: string;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcRedirectUri: string | null;
  mockAuth: boolean;
  staticMode: boolean;
  questionnaire?: {
    url: string;
    version: string;
  } | null;
  questionnaireResource?: unknown | null;
};

type RawAppConfig = {
  fhirBaseUrl?: string;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcRedirectUri?: string | null;
  mockAuth?: boolean;
  staticMode?: boolean;
  questionnaire?: {
    url: string;
    version: string;
  } | null;
  questionnaireResource?: unknown | null;
};

export type OidcMetadata = {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
};

export type StoredTokens = {
  accessToken: string;
  idToken?: string;
  expiresAt?: number;
};

type StoredPkce = {
  codeVerifier: string;
  state: string;
};

const CONFIG_URL = './config.json';
const TOKEN_STORAGE_KEY = 'fi.tokens.v1';
const PKCE_STORAGE_KEY = 'fi.pkce.v1';
const PROCESSED_CODE_KEY = 'fi.code.v1';

let appConfig: AppConfig | null = window.__APP_CONFIG ?? null;
let metadataCache: OidcMetadata | null = null;

export async function getAppConfig(): Promise<AppConfig> {
  if (appConfig) return appConfig;
  const response = await fetch(CONFIG_URL, { credentials: 'omit' });
  if (!response.ok) throw new Error('Unable to load app config');
  const raw = await response.json() as RawAppConfig;
  appConfig = {
    fhirBaseUrl: raw.fhirBaseUrl ?? new URL('./fhir', document.baseURI).pathname,
    oidcIssuer: raw.oidcIssuer ?? null,
    oidcClientId: raw.oidcClientId ?? null,
    oidcRedirectUri: raw.oidcRedirectUri ?? new URL('./', document.baseURI).toString(),
    mockAuth: Boolean(raw.mockAuth),
    staticMode: Boolean(raw.staticMode),
    questionnaire: raw.questionnaire ?? null,
    questionnaireResource: raw.questionnaireResource ?? null
  } satisfies AppConfig;
  return appConfig;
}

export async function getMetadata(): Promise<OidcMetadata> {
  if (metadataCache) return metadataCache;
  const config = await getAppConfig();
  if (!config.oidcIssuer) throw new Error('OIDC issuer not configured');
  const response = await fetch(`${config.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error('Failed to load OIDC metadata');
  metadataCache = await response.json() as OidcMetadata;
  return metadataCache;
}

export async function fetchUserInfo(accessToken: string): Promise<Record<string, unknown> | null> {
  if (!accessToken) return null;
  try {
    const metadata = await getMetadata();
    const endpoint = metadata.userinfo_endpoint;
    if (!endpoint) return null;
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      console.warn('UserInfo request failed', response.status);
      return null;
    }
    const data = await response.json() as Record<string, unknown>;
    return data;
  } catch (error) {
    console.error('Unable to load userinfo', error);
    return null;
  }
}

export function getStoredTokens(): StoredTokens | null {
  const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function clearStoredTokens() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem(PROCESSED_CODE_KEY);
}

export function setStoredTokens(tokens: StoredTokens) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

export async function startLogin(options: { mockClaims?: Record<string, unknown> } = {}): Promise<void> {
  const config = await getAppConfig();
  const metadata = await getMetadata();
  const pkce = await createPkcePair();
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkce));
  sessionStorage.removeItem(PROCESSED_CODE_KEY);

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  const clientId = config.oidcClientId ?? 'mock-client';
  const redirectUri = config.oidcRedirectUri ?? new URL('./', document.baseURI).toString();
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid profile email');
  authorizeUrl.searchParams.set('state', pkce.state);
  authorizeUrl.searchParams.set('code_challenge', pkce.codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (config.mockAuth && options.mockClaims) {
    authorizeUrl.searchParams.set('mock_jwk_claims', encodeClaims(options.mockClaims));
  }
  window.location.href = authorizeUrl.toString();
}

export async function handleRedirect(): Promise<StoredTokens | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;

  const processed = sessionStorage.getItem(PROCESSED_CODE_KEY);
  if (processed === code) {
    return getStoredTokens();
  }

  const pkceRaw = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!pkceRaw) throw new Error('Missing PKCE verifier');
  const pkce = JSON.parse(pkceRaw) as StoredPkce;
  if (pkce.state !== state) throw new Error('Invalid PKCE state');

  const metadata = await getMetadata();
  const tokens = await exchangeAuthCode(metadata, pkce.codeVerifier, code);
  storeTokens(tokens);
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
  sessionStorage.setItem(PROCESSED_CODE_KEY, code);

  params.delete('code');
  params.delete('state');
  const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash ?? ''}`;
  window.history.replaceState({}, document.title, cleanUrl);
  return tokens;
}

function storeTokens(tokens: StoredTokens) {
  setStoredTokens(tokens);
}

async function exchangeAuthCode(meta: OidcMetadata, codeVerifier: string, code: string): Promise<StoredTokens> {
  const config = await getAppConfig();
  const clientId = config.oidcClientId ?? 'mock-client';
  const redirectUri = config.oidcRedirectUri ?? `${window.location.origin}/`;
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', clientId);
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('code_verifier', codeVerifier);

  const response = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw new Error('Token exchange failed');
  const tokens = await response.json() as { access_token: string; id_token?: string; expires_in?: number };
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined
  } satisfies StoredTokens;
}

function loadPkce(): StoredPkce | null {
  const raw = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPkce;
  } catch {
    return null;
  }
}

function encodeClaims(claims: Record<string, unknown>) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
}

async function createPkcePair(): Promise<StoredPkce & { codeChallenge: string }> {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const state = base64UrlEncode(randomBytes(16));
  const codeChallenge = await pkceChallenge(codeVerifier);
  return { codeVerifier, state, codeChallenge };
}

async function pkceChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

function randomBytes(length: number): Uint8Array {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
