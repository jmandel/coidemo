import { Elysia } from 'elysia';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { SignJWT, type JWK } from 'jose';

export type MockOidcOptions = {
  basePath: string;
  issuer: string;
  defaultClientId: string;
};

type StoredAuthCode = {
  claims: Record<string, unknown>;
  clientId: string;
  scope: string | null;
};

const authCodes = new Map<string, StoredAuthCode>();

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as JWK;
publicJwk.use = 'sig';
publicJwk.alg = 'RS256';
publicJwk.kid = publicJwk.kid ?? randomUUID();

export function registerMockOidc(app: Elysia, options: MockOidcOptions) {
  const basePath = normalizeBasePath(options.basePath);
  const issuer = options.issuer;
  const authorizationEndpoint = `${basePath}/authorize`;
  const tokenEndpoint = `${basePath}/token`;
  const jwksEndpoint = `${basePath}/jwks`;
  const discoveryEndpoint = `${basePath}/.well-known/openid-configuration`;

  app.get(discoveryEndpoint, () =>
    json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none']
    })
  );

  app.get(jwksEndpoint, () => json({ keys: [publicJwk] }));

  app.get(authorizationEndpoint, ({ request }) => {
    const url = new URL(request.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    if (!redirectUri) return text('missing redirect_uri', 400);

    const state = url.searchParams.get('state');
    const claimsParam = url.searchParams.get('mock_jwk_claims');
    if (!claimsParam) return text('mock_jwk_claims required', 400);

    let claims: Record<string, unknown>;
    try {
      claims = decodeClaims(claimsParam);
    } catch (err) {
      return text('mock_jwk_claims must be base64url encoded JSON object', 400);
    }

    if (typeof claims.sub !== 'string' || !claims.sub) {
      claims = { ...claims, sub: 'mock-user' };
    }

    const clientId = url.searchParams.get('client_id') ?? options.defaultClientId;
    const code = randomUUID();
    authCodes.set(code, {
      claims,
      clientId,
      scope: url.searchParams.get('scope')
    });

    const location = appendAuthParams(redirectUri, code, state);
    return new Response(null, { status: 302, headers: { Location: location } });
  });

  app.post(tokenEndpoint, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    const code = form.get('code');
    if (!code) return text('invalid_grant', 400);

    const stored = authCodes.get(code);
    if (!stored) return text('invalid_grant', 400);
    authCodes.delete(code);

    const clientId = form.get('client_id') ?? stored.clientId;
    const scope = form.get('scope') ?? stored.scope ?? 'openid profile email';
    const nowSeconds = Math.floor(Date.now() / 1000);

    const baseClaims = {
      ...stored.claims,
      iss: issuer,
      aud: clientId,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      sub: typeof stored.claims.sub === 'string' && stored.claims.sub ? stored.claims.sub : 'mock-user'
    };

    const idToken = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
      .sign(privateKey);

    const accessToken = await new SignJWT({ ...baseClaims, scope })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
      .sign(privateKey);

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
      id_token: idToken
    });
  });
}

function normalizeBasePath(path: string) {
  if (!path.startsWith('/')) return `/${path}`;
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function decodeClaims(raw: string): Record<string, unknown> {
  const jsonString = Buffer.from(raw, 'base64url').toString('utf-8');
  const parsed = JSON.parse(jsonString);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claims payload must be JSON object');
  }
  return parsed as Record<string, unknown>;
}

function appendAuthParams(redirectUri: string, code: string, state: string | null) {
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

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function text(message: string, status: number) {
  return new Response(message, { status });
}
