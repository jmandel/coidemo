import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from './utils';

export type AuthenticatedAccessToken = {
  subjectSystem: string;
  subjectValue: string;
  display: string | null;
  payload: JWTPayload;
  token: string;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const jwksPromiseCache = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>();

function getIssuer() {
  return process.env.OIDC_ISSUER ?? env('OIDC_ISSUER');
}

function getAudience() {
  return process.env.OIDC_AUDIENCE ?? env('OIDC_AUDIENCE');
}

function getExplicitJwksUri() {
  return process.env.OIDC_JWKS_URI ?? null;
}

async function resolveJwks(issuer: string) {
  if (jwksCache.has(issuer)) return jwksCache.get(issuer)!;
  if (jwksPromiseCache.has(issuer)) return jwksPromiseCache.get(issuer)!;

  const promise = (async () => {
    const url = getExplicitJwksUri() ?? await discoverJwksUri(issuer);
    const jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(issuer, jwks);
    jwksPromiseCache.delete(issuer);
    return jwks;
  })();

  jwksPromiseCache.set(issuer, promise);
  return promise;
}

async function discoverJwksUri(issuer: string) {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const wellKnown = new URL('.well-known/openid-configuration', base).toString();
  const res = await fetch(wellKnown, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to retrieve OIDC discovery document (${res.status})`);
  const json = await res.json() as { jwks_uri?: string };
  if (!json.jwks_uri) throw new Error('OIDC discovery document missing jwks_uri');
  return json.jwks_uri;
}

function parseBearer(header: string | null | undefined) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function verifyAuthorization(header: string | null | undefined) {
  const token = parseBearer(header);
  if (!token) return null;

  const issuer = getIssuer();
  const audience = getAudience();
  const jwks = await resolveJwks(issuer);

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    if (!payload.sub) throw new Error('JWT missing subject');
    return {
      subjectSystem: `${issuer}#sub`,
      subjectValue: payload.sub,
      display: stringifyDisplay(payload),
      payload,
      token
    } satisfies AuthenticatedAccessToken;
  } catch (error) {
    console.error('Token verification failed', error);
    return null;
  }
}

function stringifyDisplay(payload: JWTPayload): string | null {
  if (typeof payload.name === 'string') return payload.name;
  if (typeof payload.preferred_username === 'string') return payload.preferred_username;
  if (typeof payload.email === 'string') return payload.email;
  return null;
}
