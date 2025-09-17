import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import './styles.css';

type AppConfig = {
  fhirBaseUrl: string;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcRedirectUri: string | null;
  mockAuth: boolean;
  questionnaire?: {
    url: string;
    version: string;
  } | null;
};

declare global {
  interface Window {
    __APP_CONFIG?: AppConfig;
  }
}

let CONFIG: AppConfig = window.__APP_CONFIG ?? {
  fhirBaseUrl: '/fhir',
  oidcIssuer: null,
  oidcClientId: null,
  oidcRedirectUri: window.location.origin,
  mockAuth: true,
  questionnaire: {
    url: 'https://example.org/hl7-coi/Questionnaire/coi',
    version: '2025.09.0'
  }
};

const TOKEN_STORAGE_KEY = 'coi.tokens.v1';
const PKCE_STORAGE_KEY = 'coi.pkce.v1';

export type Questionnaire = {
  resourceType: 'Questionnaire';
  id?: string;
  url?: string;
  version?: string;
  item?: QuestionnaireItem[];
};

export type QuestionnaireItem = {
  linkId: string;
  text?: string;
  type: string;
  repeats?: boolean;
  required?: boolean;
  item?: QuestionnaireItem[];
  answerOption?: { valueCoding?: Coding }[];
};

type Coding = {
  code?: string;
  display?: string;
  system?: string;
};

type QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse';
  id?: string;
  questionnaire?: string;
  status: string;
  authored?: string;
  subject?: {
    identifier?: {
      system?: string;
      value?: string;
    };
    display?: string;
  };
  item?: QuestionnaireResponseItem[];
};

type QuestionnaireResponseItem = {
  linkId: string;
  text?: string;
  answer?: QRAnswer[];
  item?: QuestionnaireResponseItem[];
};

type QRAnswer = {
  valueString?: string;
  valueBoolean?: boolean;
  valueCoding?: Coding;
};

type EntityType = 'for_profit' | 'nonprofit' | 'government' | 'university' | 'public' | 'private' | 'llc' | 'other';

type ParticipantInfo = {
  name: string;
  email: string;
  hl7Roles: string[];
  consentPublic: boolean;
};

type RoleDisclosure = {
  entityName: string;
  entityType: EntityType;
  role: string;
  paid: boolean;
  primaryEmployer: boolean;
  aboveThreshold: boolean | null;
};

type FinancialDisclosure = {
  fundingSource: string;
  entityType: EntityType;
  passThrough: boolean;
  intermediary: string;
};

type OwnershipDisclosure = {
  entityName: string;
  entityType: EntityType;
  tier: '1-5%' | '>5%';
};

type GiftDisclosure = {
  sponsor: string;
  entityType: EntityType;
};

type DisclosureDocument = {
  recordYear: number;
  participant: ParticipantInfo;
  roles: RoleDisclosure[];
  financial: FinancialDisclosure[];
  ownerships: OwnershipDisclosure[];
  gifts: GiftDisclosure[];
  certificationChecked: boolean;
};

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

type AuthenticatedUser = {
  sub: string;
  name: string | null;
  accessToken: string;
  idToken?: string;
  issuer: string;
  subjectSystem: string;
};

type AuthContextValue = {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  login: () => Promise<void> | void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue>({
  status: 'loading',
  user: null,
  login: () => undefined,
  logout: () => undefined
});

type StoredTokens = {
  accessToken: string;
  idToken?: string;
  expiresAt?: number;
};

type StoredPkce = {
  codeVerifier: string;
  state: string;
};

type OidcMetadata = {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
};

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [metadata, setMetadata] = useState<OidcMetadata | null>(null);
  const [configLoaded, setConfigLoaded] = useState<boolean>(Boolean(window.__APP_CONFIG));

  const ensureConfig = useCallback(async () => {
    if (configLoaded) return;
    const response = await fetch('/config.json', { credentials: 'omit' });
    if (!response.ok) {
      throw new Error('Unable to load app config');
    }
    const json = await response.json() as AppConfig;
    CONFIG = json;
    setConfigLoaded(true);
  }, [configLoaded]);

  const loadMetadata = useCallback(async (): Promise<OidcMetadata> => {
    await ensureConfig();
    if (metadata) return metadata;
    if (!CONFIG.oidcIssuer) throw new Error('OIDC issuer not configured');
    const response = await fetch(`${CONFIG.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error('Failed to load OIDC metadata');
    const json = (await response.json()) as OidcMetadata;
    setMetadata(json);
    return json;
  }, [metadata, ensureConfig]);

  const establishAuthFromTokens = useCallback((tokens: StoredTokens | null) => {
    if (!tokens) {
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    const idClaims = tokens.idToken ? decodeIdToken(tokens.idToken) : null;
    const accessClaims = decodeAccessToken(tokens.accessToken);
    const sub =
      getClaim(idClaims, 'sub') ??
      getClaim(accessClaims, 'sub') ??
      'anonymous';
    const issuerCandidate =
      getClaim(idClaims, 'iss') ??
      getClaim(accessClaims, 'iss') ??
      CONFIG.oidcIssuer ??
      (CONFIG.mockAuth ? 'urn:mock' : '');
    const issuer = issuerCandidate && issuerCandidate.length > 0 ? issuerCandidate : (CONFIG.mockAuth ? 'urn:mock' : (CONFIG.oidcIssuer ?? ''));
    const displayName =
      getClaim(idClaims, 'name') ??
      getClaim(idClaims, 'preferred_username') ??
      getClaim(idClaims, 'email') ??
      getClaim(accessClaims, 'name') ??
      getClaim(accessClaims, 'preferred_username') ??
      getClaim(accessClaims, 'email');

    const authedUser: AuthenticatedUser = {
      sub,
      name: displayName,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      issuer,
      subjectSystem: `${issuer || 'urn:mock'}#sub`
    };
    setUser(authedUser);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await ensureConfig();
      } catch (error) {
        console.error('Config load error', error);
        setStatus('unauthenticated');
        return;
      }
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.has('code') && params.has('state')) {
          const pkce = loadPkce();
          if (!pkce || pkce.state !== params.get('state')) {
            throw new Error('Invalid PKCE state');
          }
          if (!CONFIG.oidcIssuer) {
            throw new Error('OIDC issuer not configured');
          }
          const meta = await loadMetadata();
          const tokenResponse = await exchangeAuthCode(meta, pkce.codeVerifier, params.get('code')!);
          storeTokens(tokenResponse);
          sessionStorage.removeItem(PKCE_STORAGE_KEY);
          params.delete('code');
          params.delete('state');
          const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
          window.history.replaceState({}, document.title, cleanUrl);
        }
      } catch (error) {
        console.error('Authentication error', error);
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(PKCE_STORAGE_KEY);
      } finally {
        establishAuthFromTokens(loadTokens());
      }
    })();
  }, [establishAuthFromTokens, loadMetadata, ensureConfig]);

  const login = useCallback(async () => {
    try {
      const meta = await loadMetadata();
      const clientId = CONFIG.oidcClientId ?? (CONFIG.mockAuth ? 'mock-client' : null);
      if (!clientId) {
        throw new Error('OIDC client not configured');
      }
      const redirectUri = CONFIG.oidcRedirectUri ?? `${window.location.origin}/`;
      const pkce = await createPkcePair();
      sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkce));
      const authorizeUrl = new URL(meta.authorization_endpoint);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', 'openid profile email');
      authorizeUrl.searchParams.set('state', pkce.state);
      authorizeUrl.searchParams.set('code_challenge', pkce.codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      if (CONFIG.mockAuth) {
        const defaults = defaultMockClaims();
        const email = window.prompt('Mock email address', defaults.email) ?? '';
        if (!email) {
          sessionStorage.removeItem(PKCE_STORAGE_KEY);
          setStatus('unauthenticated');
          return;
        }
        const name = window.prompt('Display name', defaults.name ?? email) ?? email;
        const sub = window.prompt('Subject claim (sub)', defaults.sub ?? email) ?? email;
        const claims = {
          ...defaults,
          sub,
          email,
          name,
          iss: meta.issuer ?? CONFIG.oidcIssuer ?? 'urn:mock',
          aud: clientId
        } satisfies Record<string, unknown>;
        authorizeUrl.searchParams.set('mock_jwk_claims', encodeMockClaims(claims));
      }
      window.location.href = authorizeUrl.toString();
    } catch (error) {
      console.error('Login error', error);
      setStatus('unauthenticated');
    }
  }, [loadMetadata]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(PKCE_STORAGE_KEY);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout }),
    [status, user, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  return useContext(AuthContext);
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/form" element={<FormPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { status, user, login, logout } = useAuth();
  const location = useLocation();
  return (
    <div>
      <header>
        <div className="container" style={{ paddingTop: 16, paddingBottom: 16 }}>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/form">Disclosure Form</Link>
          </nav>
          <div className="small">
            {status === 'authenticated' && user ? (
              <>
                <span style={{ marginRight: 12 }}>Signed in as {user.name ?? user.sub}</span>
                <button className="ghost" onClick={logout}>Logout</button>
              </>
            ) : status === 'loading' ? (
              <span>Connecting…</span>
            ) : (
              <button className="primary" onClick={login}>Login</button>
            )}
          </div>
        </div>
      </header>
      <main className="container" key={location.pathname}>
        {children}
      </main>
    </div>
  );
}

function Home() {
  const { status, user, login } = useAuth();
  return (
    <Layout>
      <div className="card">
        <h1>HL7 COI Disclosure Portal</h1>
        <p>
          Complete your annual disclosure. Responses are stored as FHIR QuestionnaireResponses and can be submitted once ready.
        </p>
        {status === 'authenticated' && user ? (
          <p className="small">Welcome back, {user.name ?? user.sub}. Use the Disclosure Form tab to continue.</p>
        ) : (
          <div>
            <p className="small">Sign in with your HL7 account to get started.</p>
            <button className="primary" onClick={login}>Login</button>
          </div>
        )}
      </div>
    </Layout>
  );
}

function NotFound() {
  return (
    <Layout>
      <div className="card">
        <h1>Page not found</h1>
        <p className="small">The requested page does not exist.</p>
      </div>
    </Layout>
  );
}

function FormPage() {
  const { status, user, login } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | null>(null);
  const [document, setDocument] = useState<DisclosureDocument | null>(null);
  const [responseId, setResponseId] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string>('');
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [latestSubmitted, setLatestSubmitted] = useState<DisclosureDocument | null>(null);

  useEffect(() => {
    if (status !== 'authenticated' || !user) {
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const q = await fetchQuestionnaire(user.accessToken);
        if (cancelled) return;
        setQuestionnaire(q);
        const existing = await fetchExistingResponses(user, q);
        if (cancelled) return;
        setDocument(existing.document);
        setResponseId(existing.responseId);
        setLatestSubmitted(existing.latestSubmitted ?? null);
        setLoading(false);
      } catch (err) {
        console.error(err);
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unable to load form');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, user]);

  const updateDocument = useCallback(
    (updater: (current: DisclosureDocument) => DisclosureDocument) => {
      setDocument((prev) => {
        if (!prev) return prev;
        return updater(prev);
      });
    },
    []
  );

  const saveDraft = useCallback(async () => {
    if (!user || !questionnaire || !document) return;
    setSaveMessage('Saving…');
    try {
      const payload = documentToQuestionnaireResponse(questionnaire, document, 'in-progress');
      payload.subject = {
        identifier: {
          system: user.subjectSystem,
          value: user.sub
        },
        display: user.name ?? user.sub
      };
      const saved = await upsertQuestionnaireResponse(user.accessToken, payload, responseId);
      setResponseId(saved.id ?? null);
      setSaveMessage(`Draft saved at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.error(err);
      setSaveMessage('Failed to save draft.');
    }
  }, [user, questionnaire, document, responseId]);

  const submit = useCallback(async () => {
    if (!user || !questionnaire || !document) return;
    if (!document.participant.name || !document.participant.consentPublic || !document.certificationChecked) {
      setSubmitMessage('Complete required fields before submitting.');
      return;
    }
    setSubmitMessage('Submitting…');
    try {
      const payload = documentToQuestionnaireResponse(questionnaire, document, 'completed');
      payload.subject = {
        identifier: {
          system: user.subjectSystem,
          value: user.sub
        },
        display: user.name ?? user.sub
      };
      const saved = await upsertQuestionnaireResponse(user.accessToken, payload, responseId ?? undefined);
      setResponseId(saved.id ?? null);
      setSubmitMessage('Disclosure submitted successfully.');
    } catch (err) {
      console.error(err);
      setSubmitMessage('Unable to submit disclosure.');
    }
  }, [user, questionnaire, document, responseId]);

  const resetForm = useCallback(() => {
    if (!document) return;
    setDocument(initialDocument());
    setSaveMessage('Form reset. Remember to save.');
  }, [document]);

  const loadSample = useCallback(() => {
    const sample = sampleDocument(user?.name ?? 'Sample Discloser', user?.sub ?? 'sample@example.org');
    setDocument(sample);
    setSaveMessage('Loaded sample disclosure.');
  }, [user]);

  if (status !== 'authenticated' || !user) {
    return (
      <Layout>
        <div className="card">
          <h1>Disclosure Form</h1>
          <p className="small">You must be logged in to edit your disclosure.</p>
          <button className="primary" onClick={login}>Login</button>
        </div>
      </Layout>
    );
  }

  if (loading || !document || !questionnaire) {
    return (
      <Layout>
        <div className="card">Loading…</div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="card">
          <h1>Error</h1>
          <p className="small">{error}</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="card">
        <h1>Disclosure Form</h1>
        <p className="small">Save a draft at any time. When complete, submit to publish your disclosure.</p>
        <div className="pillRow" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={saveDraft}>Save draft</button>
          <button className="secondary" onClick={loadSample}>Load sample</button>
          <button className="ghost" onClick={resetForm}>Reset</button>
          <button className="primary" onClick={submit}>Submit disclosure</button>
        </div>
        <div className="small" style={{ marginTop: 12 }}>
          {saveMessage && <span style={{ marginRight: 12 }}>{saveMessage}</span>}
          {submitMessage && <span>{submitMessage}</span>}
        </div>
      </div>

      <ParticipantSection document={document} updateDocument={updateDocument} />
      <RolesSection document={document} updateDocument={updateDocument} />
      <FinancialSection document={document} updateDocument={updateDocument} />
      <OwnershipSection document={document} updateDocument={updateDocument} />
      <GiftsSection document={document} updateDocument={updateDocument} />
      <CertificationSection document={document} updateDocument={updateDocument} />

      {latestSubmitted ? (
        <div className="card">
          <h2>Most recent submission</h2>
          <p className="small">This summary is based on your last submitted disclosure.</p>
          <SummaryView document={latestSubmitted} />
        </div>
      ) : null}
    </Layout>
  );
}

type SectionProps = {
  document: DisclosureDocument;
  updateDocument: (fn: (current: DisclosureDocument) => DisclosureDocument) => void;
};

function ParticipantSection({ document, updateDocument }: SectionProps) {
  const participant = document.participant;
  return (
    <div className="card">
      <h2>Participant</h2>
      <div className="space-y-4">
        <label>
          Full name (public)
          <input
            type="text"
            value={participant.name}
            onChange={(e) => updateDocument((doc) => ({
              ...doc,
              participant: { ...doc.participant, name: e.target.value }
            }))}
          />
        </label>
        <label>
          Email (internal)
          <input
            type="email"
            value={participant.email}
            onChange={(e) => updateDocument((doc) => ({
              ...doc,
              participant: { ...doc.participant, email: e.target.value }
            }))}
          />
        </label>
        <label>
          HL7 roles (public)
          <select
            multiple
            value={participant.hl7Roles}
            onChange={(e) => {
              const values = Array.from(e.target.selectedOptions).map((opt) => opt.value);
              updateDocument((doc) => ({
                ...doc,
                participant: { ...doc.participant, hl7Roles: values }
              }));
            }}
            size={6}
          >
            <option value="Board">Board</option>
            <option value="Officer">Officer</option>
            <option value="Executive Committee">Executive Committee</option>
            <option value="TSC">TSC</option>
            <option value="Product Director">Product Director</option>
            <option value="Accelerator Director">Accelerator Director</option>
            <option value="Co-Chair">Co-Chair</option>
            <option value="Other">Other</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={participant.consentPublic}
            onChange={(e) => updateDocument((doc) => ({
              ...doc,
              participant: { ...doc.participant, consentPublic: e.target.checked }
            }))}
          />
          I consent to public posting of my name and disclosures.
        </label>
      </div>
    </div>
  );
}

function RolesSection({ document, updateDocument }: SectionProps) {
  const addRole = () => {
    updateDocument((doc) => ({
      ...doc,
      roles: [
        ...doc.roles,
        {
          entityName: '',
          entityType: 'for_profit',
          role: '',
          paid: false,
          primaryEmployer: false,
          aboveThreshold: null
        }
      ]
    }));
  };

  const removeRole = (idx: number) => {
    updateDocument((doc) => ({
      ...doc,
      roles: doc.roles.filter((_, i) => i !== idx)
    }));
  };

  return (
    <div className="card">
      <div className="sectionHeader">
        <div>
          <h2>Professional roles</h2>
          <p className="small">Include primary employer and governance/advisory roles meeting the disclosure threshold.</p>
        </div>
        <button className="secondary" onClick={addRole}>Add role</button>
      </div>
      {document.roles.length === 0 ? (
        <p className="small">No roles added yet.</p>
      ) : (
        document.roles.map((role, idx) => (
          <div key={idx} className="listItem">
            <div className="listItemHeader">
              <div className="itemBadge">Role {idx + 1}</div>
              <button className="ghost" onClick={() => removeRole(idx)}>Remove</button>
            </div>
            <div className="itemFields">
              <label>
                Entity name
                <input
                  value={role.entityName}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, entityName: e.target.value } : r))
                  }))}
                />
              </label>
              <label>
                Entity type
                <select
                  value={role.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, entityType: e.target.value as EntityType } : r))
                  }))}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="university">University</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Role / Title
                <input
                  value={role.role}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, role: e.target.value } : r))
                  }))}
                />
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={role.primaryEmployer}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, primaryEmployer: e.target.checked, paid: e.target.checked || r.paid } : r))
                  }))}
                />
                Primary employer
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={role.paid}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, paid: e.target.checked } : r))
                  }))}
                />
                Paid role
              </label>
              <label>
                Compensation meets threshold?
                <select
                  value={role.aboveThreshold === null ? 'unknown' : role.aboveThreshold ? 'true' : 'false'}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (
                      i === idx
                        ? { ...r, aboveThreshold: e.target.value === 'unknown' ? null : e.target.value === 'true' }
                        : r
                    ))
                  }))}
                >
                  <option value="unknown">Not sure / not applicable</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function FinancialSection({ document, updateDocument }: SectionProps) {
  const addEntry = () => {
    updateDocument((doc) => ({
      ...doc,
      financial: [
        ...doc.financial,
        { fundingSource: '', entityType: 'for_profit', passThrough: false, intermediary: '' }
      ]
    }));
  };
  const removeEntry = (idx: number) => {
    updateDocument((doc) => ({
      ...doc,
      financial: doc.financial.filter((_, i) => i !== idx)
    }));
  };

  return (
    <div className="card">
      <div className="sectionHeader">
        <div>
          <h2>Funding sources</h2>
          <p className="small">Report sources meeting the HL7 disclosure threshold in the prior 12 months.</p>
        </div>
        <button className="secondary" onClick={addEntry}>Add source</button>
      </div>
      {document.financial.length === 0 ? (
        <p className="small">No funding sources listed.</p>
      ) : (
        document.financial.map((entry, idx) => (
          <div key={idx} className="listItem">
            <div className="listItemHeader">
              <div className="itemBadge">Source {idx + 1}</div>
              <button className="ghost" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="itemFields">
              <label>
                Funding source
                <input
                  value={entry.fundingSource}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, fundingSource: e.target.value } : f))
                  }))}
                />
              </label>
              <label>
                Entity type
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, entityType: e.target.value as EntityType } : f))
                  }))}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="university">University</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={entry.passThrough}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, passThrough: e.target.checked } : f))
                  }))}
                />
                Paid via intermediary
              </label>
              {entry.passThrough ? (
                <label>
                  Intermediary
                  <input
                    value={entry.intermediary}
                    onChange={(e) => updateDocument((doc) => ({
                      ...doc,
                      financial: doc.financial.map((f, i) => (i === idx ? { ...f, intermediary: e.target.value } : f))
                    }))}
                  />
                </label>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function OwnershipSection({ document, updateDocument }: SectionProps) {
  const addEntry = () => {
    updateDocument((doc) => ({
      ...doc,
      ownerships: [
        ...doc.ownerships,
        { entityName: '', entityType: 'public', tier: '1-5%' }
      ]
    }));
  };
  const removeEntry = (idx: number) => {
    updateDocument((doc) => ({
      ...doc,
      ownerships: doc.ownerships.filter((_, i) => i !== idx)
    }));
  };

  return (
    <div className="card">
      <div className="sectionHeader">
        <div>
          <h2>Ownership interests (≥ 1%)</h2>
          <p className="small">List entities where you own at least 1%.</p>
        </div>
        <button className="secondary" onClick={addEntry}>Add ownership</button>
      </div>
      {document.ownerships.length === 0 ? (
        <p className="small">No ownership interests listed.</p>
      ) : (
        document.ownerships.map((entry, idx) => (
          <div key={idx} className="listItem">
            <div className="listItemHeader">
              <div className="itemBadge">Ownership {idx + 1}</div>
              <button className="ghost" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="itemFields">
              <label>
                Entity name
                <input
                  value={entry.entityName}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, entityName: e.target.value } : o))
                  }))}
                />
              </label>
              <label>
                Entity type
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, entityType: e.target.value as EntityType } : o))
                  }))}
                >
                  <option value="public">Publicly traded</option>
                  <option value="private">Privately held</option>
                  <option value="llc">Partnership / LLC</option>
                  <option value="nonprofit">Nonprofit / Other</option>
                </select>
              </label>
              <label>
                Ownership tier
                <select
                  value={entry.tier}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, tier: e.target.value as OwnershipDisclosure['tier'] } : o))
                  }))}
                >
                  <option value="1-5%">1–5%</option>
                  <option value=">5%">&gt;5%</option>
                </select>
              </label>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function GiftsSection({ document, updateDocument }: SectionProps) {
  const addEntry = () => {
    updateDocument((doc) => ({
      ...doc,
      gifts: [
        ...doc.gifts,
        { sponsor: '', entityType: 'for_profit' }
      ]
    }));
  };
  const removeEntry = (idx: number) => {
    updateDocument((doc) => ({
      ...doc,
      gifts: doc.gifts.filter((_, i) => i !== idx)
    }));
  };
  return (
    <div className="card">
      <div className="sectionHeader">
        <div>
          <h2>Sponsored travel, gifts & hospitality</h2>
          <p className="small">Include sponsors exceeding $10k from a single source in a calendar year.</p>
        </div>
        <button className="secondary" onClick={addEntry}>Add sponsor</button>
      </div>
      {document.gifts.length === 0 ? (
        <p className="small">No entries.</p>
      ) : (
        document.gifts.map((entry, idx) => (
          <div key={idx} className="listItem">
            <div className="listItemHeader">
              <div className="itemBadge">Sponsor {idx + 1}</div>
              <button className="ghost" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="itemFields">
              <label>
                Sponsor
                <input
                  value={entry.sponsor}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    gifts: doc.gifts.map((g, i) => (i === idx ? { ...g, sponsor: e.target.value } : g))
                  }))}
                />
              </label>
              <label>
                Entity type
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    gifts: doc.gifts.map((g, i) => (i === idx ? { ...g, entityType: e.target.value as EntityType } : g))
                  }))}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="other">Other</option>
                </select>
              </label>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function CertificationSection({ document, updateDocument }: SectionProps) {
  return (
    <div className="card">
      <h2>Certification</h2>
      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={document.certificationChecked}
          onChange={(e) => updateDocument((doc) => ({
            ...doc,
            certificationChecked: e.target.checked
          }))}
        />
        I certify I have disclosed all interests per HL7 thresholds and agree to public posting.
      </label>
    </div>
  );
}

function SummaryView({ document }: { document: DisclosureDocument }) {
  return (
    <div className="entryGroups">
      <div className="entryGroup">
        <div className="groupTitle">Participant</div>
        <ul>
          <li>{document.participant.name} ({document.participant.hl7Roles.join(', ') || 'No roles'})</li>
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Roles ({document.roles.length})</div>
        <ul>
          {document.roles.length === 0 ? <li>None</li> : document.roles.map((role, idx) => (
            <li key={idx}>{role.entityName} — {role.role}</li>
          ))}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Funding sources ({document.financial.length})</div>
        <ul>
          {document.financial.length === 0 ? <li>None</li> : document.financial.map((entry, idx) => (
            <li key={idx}>{entry.fundingSource}{entry.passThrough && entry.intermediary ? ` via ${entry.intermediary}` : ''}</li>
          ))}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Ownerships ({document.ownerships.length})</div>
        <ul>
          {document.ownerships.length === 0 ? <li>None</li> : document.ownerships.map((entry, idx) => (
            <li key={idx}>{entry.entityName} ({entry.tier})</li>
          ))}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Gifts / Travel ({document.gifts.length})</div>
        <ul>
          {document.gifts.length === 0 ? <li>None</li> : document.gifts.map((entry, idx) => (
            <li key={idx}>{entry.sponsor}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- Helpers ---

function initialDocument(): DisclosureDocument {
  return {
    recordYear: new Date().getFullYear(),
    participant: { name: '', email: '', hl7Roles: [], consentPublic: false },
    roles: [],
    financial: [],
    ownerships: [],
    gifts: [],
    certificationChecked: false
  };
}

function sampleDocument(name: string, email: string): DisclosureDocument {
  return {
    recordYear: new Date().getFullYear(),
    participant: {
      name,
      email,
      hl7Roles: ['Board', 'TSC'],
      consentPublic: true
    },
    roles: [
      {
        entityName: 'Vanta Clinical Platforms',
        entityType: 'for_profit',
        role: 'Chief Standards Strategist',
        paid: true,
        primaryEmployer: true,
        aboveThreshold: true
      },
      {
        entityName: 'Nimbus Interop Cooperative',
        entityType: 'nonprofit',
        role: 'Program Advisor',
        paid: false,
        primaryEmployer: false,
        aboveThreshold: null
      }
    ],
    financial: [
      {
        fundingSource: 'Beacon Health Analytics',
        entityType: 'for_profit',
        passThrough: true,
        intermediary: 'Lattice Consulting Group'
      }
    ],
    ownerships: [
      {
        entityName: 'Helios Standards Exchange',
        entityType: 'private',
        tier: '1-5%'
      }
    ],
    gifts: [
      {
        sponsor: 'Atlas Summit Collective',
        entityType: 'nonprofit'
      }
    ],
    certificationChecked: true
  };
}

async function fetchQuestionnaire(accessToken: string): Promise<Questionnaire> {
  const canonical = CONFIG.questionnaire ?? { url: '', version: '' };
  const search = new URLSearchParams();
  if (canonical.url) search.set('url', canonical.url);
  if (canonical.version) search.set('version', canonical.version);
  search.set('_count', '1');
  const res = await fhirFetch(`/Questionnaire?${search.toString()}`, accessToken);
  const bundle = await res.json() as { entry?: { resource?: Questionnaire }[] };
  const questionnaire = bundle.entry?.[0]?.resource;
  if (!questionnaire) throw new Error('Questionnaire not found');
  return questionnaire;
}

type ExistingResponseLoad = {
  document: DisclosureDocument;
  responseId: string | null;
  latestSubmitted?: DisclosureDocument;
};

async function fetchExistingResponses(user: AuthenticatedUser, questionnaire: Questionnaire): Promise<ExistingResponseLoad> {
  const canonical = canonicalFromQuestionnaire(questionnaire);
  const searchDraft = new URLSearchParams();
  searchDraft.set('subject:identifier', `${user.subjectSystem}|${user.sub}`);
  searchDraft.set('questionnaire', canonical);
  searchDraft.set('status', 'in-progress');
  searchDraft.set('_count', '1');
  const draftRes = await fhirFetch(`/QuestionnaireResponse?${searchDraft.toString()}`, user.accessToken);
  const draftBundle = await draftRes.json() as FhirBundle<QuestionnaireResponse>;
  const draft = draftBundle.entry?.[0]?.resource ?? null;

  if (draft) {
    return {
      document: questionnaireResponseToDocument(questionnaire, draft),
      responseId: draft.id ?? null,
      latestSubmitted: undefined
    };
  }

  const searchCompleted = new URLSearchParams();
  searchCompleted.set('subject:identifier', `${user.subjectSystem}|${user.sub}`);
  searchCompleted.set('questionnaire', canonical);
  searchCompleted.set('status', 'completed');
  searchCompleted.set('_count', '1');
  const completedRes = await fhirFetch(`/QuestionnaireResponse?${searchCompleted.toString()}`, user.accessToken);
  const completedBundle = await completedRes.json() as FhirBundle<QuestionnaireResponse>;
  const latest = completedBundle.entry?.[0]?.resource ?? null;

  if (latest) {
    const doc = questionnaireResponseToDocument(questionnaire, latest);
    return {
      document: doc,
      responseId: null,
      latestSubmitted: doc
    };
  }

  return {
    document: initialDocument(),
    responseId: null
  };
}

type FhirBundle<T> = {
  entry?: { resource?: T }[];
};

function canonicalFromQuestionnaire(questionnaire: Questionnaire): string {
  const url = questionnaire.url ?? CONFIG.questionnaire?.url ?? '';
  const version = questionnaire.version ?? CONFIG.questionnaire?.version;
  return version ? `${url}|${version}` : url;
}

async function upsertQuestionnaireResponse(accessToken: string, payload: QuestionnaireResponse, existingId?: string | null): Promise<QuestionnaireResponse> {
  const method = existingId ? 'PUT' : 'POST';
  const path = existingId ? `/QuestionnaireResponse/${existingId}` : '/QuestionnaireResponse';
  const res = await fhirFetch(path, accessToken, {
    method,
    body: JSON.stringify(payload)
  });
  return (await res.json()) as QuestionnaireResponse;
}

async function fhirFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${CONFIG.fhirBaseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set('Accept', 'application/fhir+json');
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/fhir+json');
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `FHIR request failed (${response.status})`);
  }
  return response;
}

function questionnaireResponseToDocument(questionnaire: Questionnaire, response: QuestionnaireResponse): DisclosureDocument {
  const doc = initialDocument();
  const items = response.item ?? [];
  const participantGroup = findItem(items, 'participant');
  if (participantGroup) {
    doc.participant.name = getString(participantGroup, 'participant.name');
    doc.participant.email = getString(participantGroup, 'participant.email');
    doc.participant.hl7Roles = getCodingList(participantGroup, 'participant.hl7Roles');
    doc.participant.consentPublic = getBoolean(participantGroup, 'participant.consentPublic');
  }
  const roleGroups = findItems(items, 'roles');
  doc.roles = roleGroups.map((group) => ({
    entityName: getString(group, 'roles.entityName'),
    entityType: (getCoding(group, 'roles.entityType') as EntityType) || 'for_profit',
    role: getString(group, 'roles.role'),
    paid: getBoolean(group, 'roles.paid'),
    primaryEmployer: getBoolean(group, 'roles.primaryEmployer'),
    aboveThreshold: decodeAboveThreshold(getCoding(group, 'roles.aboveThreshold'))
  })).filter((role) => role.entityName || role.role);

  const financialGroups = findItems(items, 'financial');
  doc.financial = financialGroups.map((group) => ({
    fundingSource: getString(group, 'financial.fundingSource'),
    entityType: (getCoding(group, 'financial.entityType') as EntityType) || 'for_profit',
    passThrough: getBoolean(group, 'financial.passThrough'),
    intermediary: getString(group, 'financial.intermediary')
  })).filter((entry) => entry.fundingSource);

  const ownershipGroups = findItems(items, 'ownerships');
  doc.ownerships = ownershipGroups.map((group) => ({
    entityName: getString(group, 'ownerships.entityName'),
    entityType: (getCoding(group, 'ownerships.entityType') as EntityType) || 'public',
    tier: (getCoding(group, 'ownerships.tier') as OwnershipDisclosure['tier']) || '1-5%'
  })).filter((entry) => entry.entityName);

  const giftGroups = findItems(items, 'gifts');
  doc.gifts = giftGroups.map((group) => ({
    sponsor: getString(group, 'gifts.sponsor'),
    entityType: (getCoding(group, 'gifts.entityType') as EntityType) || 'for_profit'
  })).filter((entry) => entry.sponsor);

  const certificationGroup = findItem(items, 'certification');
  if (certificationGroup) {
    doc.certificationChecked = getBoolean(certificationGroup, 'certification.statement');
  }

  return doc;
}

function documentToQuestionnaireResponse(questionnaire: Questionnaire, document: DisclosureDocument, status: 'in-progress' | 'completed'): QuestionnaireResponse {
  const canonical = canonicalFromQuestionnaire(questionnaire);
  const response: QuestionnaireResponse = {
    resourceType: 'QuestionnaireResponse',
    questionnaire: canonical,
    status,
    authored: new Date().toISOString(),
    item: []
  };
  const topLevelItems = questionnaire.item ?? [];

  const participantTemplate = findQuestionnaireItem(topLevelItems, 'participant');
  if (participantTemplate) {
    response.item!.push(buildParticipantItem(participantTemplate, document.participant));
  }

  const rolesTemplate = findQuestionnaireItem(topLevelItems, 'roles');
  if (rolesTemplate) {
    for (const role of document.roles) {
      response.item!.push(buildRoleItem(rolesTemplate, role));
    }
  }

  const financialTemplate = findQuestionnaireItem(topLevelItems, 'financial');
  if (financialTemplate) {
    for (const entry of document.financial) {
      response.item!.push(buildFinancialItem(financialTemplate, entry));
    }
  }

  const ownershipTemplate = findQuestionnaireItem(topLevelItems, 'ownerships');
  if (ownershipTemplate) {
    for (const entry of document.ownerships) {
      response.item!.push(buildOwnershipItem(ownershipTemplate, entry));
    }
  }

  const giftsTemplate = findQuestionnaireItem(topLevelItems, 'gifts');
  if (giftsTemplate) {
    for (const entry of document.gifts) {
      response.item!.push(buildGiftItem(giftsTemplate, entry));
    }
  }

  const certificationTemplate = findQuestionnaireItem(topLevelItems, 'certification');
  if (certificationTemplate) {
    response.item!.push(buildCertificationItem(certificationTemplate, document.certificationChecked));
  }

  return response;
}

function buildParticipantItem(template: QuestionnaireItem, participant: ParticipantInfo): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) => {
      if (child.linkId === 'participant.name') {
        return answerItem(child, participant.name ? [{ valueString: participant.name }] : []);
      }
      if (child.linkId === 'participant.email') {
        return answerItem(child, participant.email ? [{ valueString: participant.email }] : []);
      }
      if (child.linkId === 'participant.hl7Roles') {
        return answerItem(child, participant.hl7Roles.map((code) => ({ valueCoding: { code, display: code } })));
      }
      if (child.linkId === 'participant.consentPublic') {
        return answerItem(child, [{ valueBoolean: participant.consentPublic }]);
      }
      return answerItem(child, []);
    })
  };
}

function buildRoleItem(template: QuestionnaireItem, role: RoleDisclosure): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) => {
      switch (child.linkId) {
        case 'roles.entityName':
          return answerItem(child, role.entityName ? [{ valueString: role.entityName }] : []);
        case 'roles.entityType':
          return answerItem(child, [{ valueCoding: { code: role.entityType, display: role.entityType } }]);
        case 'roles.role':
          return answerItem(child, role.role ? [{ valueString: role.role }] : []);
        case 'roles.primaryEmployer':
          return answerItem(child, [{ valueBoolean: role.primaryEmployer }]);
        case 'roles.paid':
          return answerItem(child, [{ valueBoolean: role.paid }]);
        case 'roles.aboveThreshold':
          return answerItem(
            child,
            role.aboveThreshold === null
              ? []
              : [{ valueCoding: { code: role.aboveThreshold ? 'true' : 'false', display: role.aboveThreshold ? 'Yes' : 'No' } }]
          );
        default:
          return answerItem(child, []);
      }
    })
  };
}

function buildFinancialItem(template: QuestionnaireItem, entry: FinancialDisclosure): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) => {
      switch (child.linkId) {
        case 'financial.fundingSource':
          return answerItem(child, entry.fundingSource ? [{ valueString: entry.fundingSource }] : []);
        case 'financial.entityType':
          return answerItem(child, [{ valueCoding: { code: entry.entityType, display: entry.entityType } }]);
        case 'financial.passThrough':
          return answerItem(child, [{ valueBoolean: entry.passThrough }]);
        case 'financial.intermediary':
          return answerItem(child, entry.intermediary ? [{ valueString: entry.intermediary }] : []);
        default:
          return answerItem(child, []);
      }
    })
  };
}

function buildOwnershipItem(template: QuestionnaireItem, entry: OwnershipDisclosure): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) => {
      switch (child.linkId) {
        case 'ownerships.entityName':
          return answerItem(child, entry.entityName ? [{ valueString: entry.entityName }] : []);
        case 'ownerships.entityType':
          return answerItem(child, [{ valueCoding: { code: entry.entityType, display: entry.entityType } }]);
        case 'ownerships.tier':
          return answerItem(child, [{ valueCoding: { code: entry.tier, display: entry.tier } }]);
        default:
          return answerItem(child, []);
      }
    })
  };
}

function buildGiftItem(template: QuestionnaireItem, entry: GiftDisclosure): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) => {
      switch (child.linkId) {
        case 'gifts.sponsor':
          return answerItem(child, entry.sponsor ? [{ valueString: entry.sponsor }] : []);
        case 'gifts.entityType':
          return answerItem(child, [{ valueCoding: { code: entry.entityType, display: entry.entityType } }]);
        default:
          return answerItem(child, []);
      }
    })
  };
}

function buildCertificationItem(template: QuestionnaireItem, checked: boolean): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    item: (template.item ?? []).map((child) =>
      child.linkId === 'certification.statement'
        ? answerItem(child, [{ valueBoolean: checked }])
        : answerItem(child, [])
    )
  };
}

function answerItem(template: QuestionnaireItem, answers: QRAnswer[]): QuestionnaireResponseItem {
  return {
    linkId: template.linkId,
    text: template.text,
    answer: answers,
    item: undefined
  };
}

function findItem(items: QuestionnaireResponseItem[] | undefined, linkId: string): QuestionnaireResponseItem | undefined {
  return (items ?? []).find((item) => item.linkId === linkId);
}

function findItems(items: QuestionnaireResponseItem[] | undefined, linkId: string): QuestionnaireResponseItem[] {
  return (items ?? []).filter((item) => item.linkId === linkId);
}

function getString(group: QuestionnaireResponseItem, childLinkId: string): string {
  const item = findItem(group.item, childLinkId);
  const answer = item?.answer?.find((ans) => typeof ans.valueString === 'string');
  return answer?.valueString ?? '';
}

function getBoolean(group: QuestionnaireResponseItem, childLinkId: string): boolean {
  const item = findItem(group.item, childLinkId);
  const answer = item?.answer?.find((ans) => typeof ans.valueBoolean === 'boolean');
  return answer?.valueBoolean ?? false;
}

function getCoding(group: QuestionnaireResponseItem, childLinkId: string): string {
  const item = findItem(group.item, childLinkId);
  const answer = item?.answer?.find((ans) => ans.valueCoding);
  return answer?.valueCoding?.code ?? '';
}

function getCodingList(group: QuestionnaireResponseItem | undefined, childLinkId: string): string[] {
  const item = group ? findItem(group.item, childLinkId) : undefined;
  if (!item?.answer) return [];
  return item.answer.map((ans) => ans.valueCoding?.code).filter((code): code is string => Boolean(code));
}

function decodeAboveThreshold(code: string): boolean | null {
  if (code === 'true') return true;
  if (code === 'false') return false;
  return null;
}

function findQuestionnaireItem(items: QuestionnaireItem[], linkId: string): QuestionnaireItem | undefined {
  return items.find((item) => item.linkId === linkId);
}

function loadTokens(): StoredTokens | null {
  const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

function storeTokens(tokens: { access_token: string; id_token?: string; expires_in?: number }) {
  const stored: StoredTokens = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined
  };
  sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored));
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

async function exchangeAuthCode(meta: OidcMetadata, codeVerifier: string, code: string) {
  const clientId = CONFIG.oidcClientId ?? (CONFIG.mockAuth ? 'mock-client' : null);
  if (!clientId) throw new Error('OIDC client not configured');
  const redirectUri = CONFIG.oidcRedirectUri ?? `${window.location.origin}/`;
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
  if (!response.ok) {
    throw new Error('Token exchange failed');
  }
  return response.json() as Promise<{ access_token: string; id_token?: string; expires_in?: number }>;
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

function decodeIdToken(idToken: string): Record<string, any> | null {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    const decoded = JSON.parse(decodeBase64Url(payload));
    return decoded as Record<string, any>;
  } catch {
    return null;
  }
}

function decodeAccessToken(token: string): Record<string, unknown> | null {
  try {
    const json = decodeBase64Url(token);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // swallow
  }
  return null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padBase64(normalized));
}

function getClaim(claims: Record<string, unknown> | null, key: string): string | null {
  if (!claims) return null;
  const value = claims[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function encodeMockClaims(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims);
  return base64UrlEncode(new TextEncoder().encode(json));
}

function defaultMockClaims(): { sub: string; email: string; name: string; preferred_username: string } {
  return {
    sub: 'mock-user',
    email: 'jane.doe@example.org',
    name: 'Jane Doe',
    preferred_username: 'jane.doe'
  };
}

function padBase64(value: string): string {
  const remainder = value.length % 4;
  if (remainder === 2) return `${value}==`;
  if (remainder === 3) return `${value}=`;
  if (remainder === 1) return `${value}===`;
  return value;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');
createRoot(rootElement).render(<App />);
