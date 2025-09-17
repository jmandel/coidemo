import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { Buffer } from 'node:buffer';
import { env } from './utils';

export type AuthenticatedAccessToken = {
  subjectSystem: string;
  subjectValue: string;
  display: string | null;
  payload: JWTPayload;
  token: string;
};

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksInitPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

const allowMock = process.env.MOCK_AUTH === 'true';
const issuer = allowMock ? 'urn:mock' : env('OIDC_ISSUER');
const audience = allowMock ? 'urn:mock:audience' : env('OIDC_AUDIENCE');
const explicitJwksUri = allowMock ? null : process.env.OIDC_JWKS_URI ?? null;

async function resolveJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (allowMock) {
    throw new Error('JWKS not available in mock mode');
  }
  if (remoteJwks) return remoteJwks;
  if (jwksInitPromise) return jwksInitPromise;

  jwksInitPromise = (async () => {
    const jwksUrl = explicitJwksUri ?? await discoverJwksUri(issuer);
    const jwks = createRemoteJWKSet(new URL(jwksUrl));
    remoteJwks = jwks;
    return jwks;
  })();

  return jwksInitPromise;
}

async function discoverJwksUri(iss: string): Promise<string> {
  const base = iss.endsWith('/') ? iss : `${iss}/`;
  const wellKnown = new URL('.well-known/openid-configuration', base).toString();
  const res = await fetch(wellKnown, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to retrieve OIDC discovery document (${res.status})`);
  }
  const json = (await res.json()) as { jwks_uri?: string };
  if (!json.jwks_uri) {
    throw new Error('OIDC discovery document missing jwks_uri');
  }
  return json.jwks_uri;
}

function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1];
}

export async function verifyAuthorization(header: string | null | undefined): Promise<AuthenticatedAccessToken | null> {
  if (allowMock) {
    const token = parseBearer(header);
    if (!token) return null;
    const claims = decodeMockToken(token);
    if (!claims) return null;
    const sub = typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : 'mock-user';
    const issuerValue = typeof claims.iss === 'string' && claims.iss.length > 0 ? claims.iss : 'urn:mock';
    const display = stringifyDisplay(claims) ?? sub;
    return {
      subjectSystem: `${issuerValue}#sub`,
      subjectValue: sub,
      display,
      payload: claims,
      token
    };
  }

  const token = parseBearer(header);
  if (!token) return null;

  const jwks = await resolveJwks();
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience
    });
    const sub = payload.sub;
    if (!sub) {
      throw new Error('JWT missing subject');
    }
    const display = stringifyDisplay(payload);
    return {
      subjectSystem: `${issuer}#sub`,
      subjectValue: sub,
      display,
      payload,
      token
    };
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

function decodeMockToken(token: string): JWTPayload | null {
  try {
    const json = base64UrlDecode(token);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JWTPayload;
    }
  } catch (error) {
    console.error('Failed to decode mock token', error);
  }
  return null;
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf-8');
}
