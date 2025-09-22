import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import './styles.css';
import {
  AppConfig,
  StoredTokens,
  getAppConfig,
  getStoredTokens,
  clearStoredTokens,
  setStoredTokens,
  startLogin as oauthStartLogin,
  handleRedirect
} from './oauth';

declare global {
  interface Window {
    __APP_CONFIG?: AppConfig;
  }
}

const documentBase = new URL(document.baseURI);
const routerBasename = documentBase.pathname.replace(/\/$/, '') || '/';

const absolutePath = (relative: string) => new URL(relative, documentBase).pathname;

const relativeToBase = (pathname: string): string => {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (routerBasename === '/' || !normalized.startsWith(routerBasename)) {
    return normalized;
  }
  const stripped = normalized.slice(routerBasename.length);
  return stripped.startsWith('/') ? stripped || '/' : `/${stripped}`;
};

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
  meta?: {
    lastUpdated?: string;
  };
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
  hl7Roles: string[];
};

type RoleInterest = {
  entityName: string;
  entityType: EntityType;
  role: string;
  paid: boolean;
  primaryEmployer: boolean;
};

type FundingInterest = {
  fundingSource: string;
  entityType: EntityType;
  passThrough: boolean;
  intermediary: string;
};

type OwnershipInterest = {
  entityName: string;
  entityType: EntityType;
  tier: '1-5%' | '>5%';
};

type GiftInterest = {
  sponsor: string;
  entityType: EntityType;
};

type FinancialInterestsDocument = {
  recordYear: number;
  participant: ParticipantInfo;
  roles: RoleInterest[];
  financial: FundingInterest[];
  ownerships: OwnershipInterest[];
  gifts: GiftInterest[];
  certificationChecked: boolean;
};

type DocumentUpdater = (current: FinancialInterestsDocument) => FinancialInterestsDocument;

type CompletedHistoryEntry = {
  key: string;
  response: QuestionnaireResponse;
  document: FinancialInterestsDocument;
};

type ExistingResponseLoad = {
  document: FinancialInterestsDocument;
  responseId: string | null;
  latestSubmitted?: FinancialInterestsDocument;
  completedHistory: CompletedHistoryEntry[];
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

type SubmissionBackend = {
  fetchQuestionnaire(user: AuthenticatedUser): Promise<Questionnaire>;
  loadExisting(user: AuthenticatedUser, questionnaire: Questionnaire): Promise<ExistingResponseLoad>;
  saveDraft(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse>;
  submit(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse>;
};

let submissionBackendPromise: Promise<SubmissionBackend> | null = null;

async function getSubmissionBackend(): Promise<SubmissionBackend> {
  if (submissionBackendPromise) return submissionBackendPromise;
  submissionBackendPromise = (async () => {
    const config = await getAppConfig();
    if (config.staticMode) {
      return new StaticSubmissionBackend();
    }
    return new FhirSubmissionBackend();
  })();
  return submissionBackendPromise;
}

const wizardSteps = [
  { id: 0, title: 'Intro' },
  { id: 1, title: 'Roles' },
  { id: 2, title: 'Funding' },
  { id: 3, title: 'Ownership' },
  { id: 4, title: 'Gifts / Travel' },
  { id: 5, title: 'Review & Submit' }
];

const fieldLabelClass = 'block text-sm font-medium text-slate-700';
const fieldInputClass = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200';
const selectInputClass = `${fieldInputClass} bg-white`;
const checkboxInputClass = 'h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-200 focus:outline-none';
const sectionCardGap = 24;
const POST_LOGIN_REDIRECT_KEY = 'fi.postLoginRedirect';

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function summarizeDocumentCounts(doc: FinancialInterestsDocument) {
  return {
    roles: doc.roles.length,
    financial: doc.financial.length,
    ownerships: doc.ownerships.length,
    gifts: doc.gifts.length
  };
}

function formatSummaryCounts(counts: ReturnType<typeof summarizeDocumentCounts>) {
  return [
    `${counts.roles} role${counts.roles === 1 ? '' : 's'}`,
    `${counts.financial} funding source${counts.financial === 1 ? '' : 's'}`,
    `${counts.ownerships} ownership${counts.ownerships === 1 ? '' : 's'}`,
    `${counts.gifts} gift/travel item${counts.gifts === 1 ? '' : 's'}`
  ].join(' • ');
}

type AutoSaveState = {
  scheduledAt: number | null;
  handle: ReturnType<typeof setTimeout> | null;
  pending: boolean;
};

type FinancialInterestsStore = {
  user: AuthenticatedUser | null;
  status: 'idle' | 'loading' | 'ready' | 'submitting' | 'error';
  error: string | null;
  questionnaire: Questionnaire | null;
  document: FinancialInterestsDocument;
  responseId: string | null;
  latestSubmitted: FinancialInterestsDocument | null;
  lastSubmittedDocument: FinancialInterestsDocument | null;
  history: CompletedHistoryEntry[];
  step: number;
  saveMessage: string;
  submitMessage: string;
  autoSave: AutoSaveState;
  canAdvanceIntro: () => boolean;
  summaryCounts: () => ReturnType<typeof summarizeDocumentCounts>;
  summaryText: () => string;
  setUser: (user: AuthenticatedUser | null) => void;
  initialize: () => Promise<void>;
  updateDocument: (updater: DocumentUpdater, opts?: { queueAutoSave?: boolean }) => void;
  setDocument: (next: FinancialInterestsDocument, opts?: { queueAutoSave?: boolean }) => void;
  setStep: (step: number) => void;
  resetDocument: (opts?: { preserveHistory?: boolean }) => void;
  loadSample: () => Promise<void>;
  loadFromHistory: (responseId: string) => Promise<void>;
  loadLatestSubmission: () => Promise<void>;
  saveDraft: (opts?: { silent?: boolean; document?: FinancialInterestsDocument }) => Promise<void>;
  submit: () => Promise<'success' | 'error'>;
  refreshHistory: () => Promise<void>;
  cancelAutoSave: () => void;
  clearMessages: () => void;
  setError: (message: string | null) => void;
};

const financialInterestsStore = createStore<FinancialInterestsStore>((set, get) => {
  const queueAutoSave = () => {
    const existing = get().autoSave;
    if (existing.handle) {
      clearTimeout(existing.handle);
    }
    const delayMs = 1500;
    const handle = setTimeout(() => {
      void get().saveDraft({ silent: true });
    }, delayMs);
    set({
      autoSave: {
        scheduledAt: Date.now() + delayMs,
        handle,
        pending: true
      }
    });
  };

  const applyDocumentUpdate = (updater: DocumentUpdater, queue: boolean | undefined) => {
    const current = get().document;
    const next = updater(cloneDocument(current));
    set({ document: next });
    if (queue !== false) {
      queueAutoSave();
    }
  };

  const setDocumentInternal = (next: FinancialInterestsDocument, queue?: boolean) => {
    set({ document: cloneDocument(next) });
    if (queue !== false) {
      queueAutoSave();
    }
  };

  const resetAutoSaveState = () => {
    const existing = get().autoSave;
    if (existing.handle) {
      clearTimeout(existing.handle);
    }
    set({
      autoSave: {
        scheduledAt: null,
        handle: null,
        pending: false
      }
    });
  };

  return {
    user: null,
    status: 'idle',
    error: null,
    questionnaire: null,
    document: initialDocument(),
    responseId: null,
    latestSubmitted: null,
    lastSubmittedDocument: null,
    history: [],
    step: 0,
    saveMessage: '',
    submitMessage: '',
    autoSave: {
      scheduledAt: null,
      handle: null,
      pending: false
    },
    canAdvanceIntro: () => {
      const { document } = get();
      return Boolean(document.participant.name);
    },
    summaryCounts: () => summarizeDocumentCounts(get().document),
    summaryText: () => formatSummaryCounts(summarizeDocumentCounts(get().document)),
    setUser: (user) => {
      const prevUser = get().user;
      if (!user) {
        resetAutoSaveState();
        set({
          user: null,
          status: 'idle',
          questionnaire: null,
          document: initialDocument(),
          responseId: null,
          latestSubmitted: null,
          lastSubmittedDocument: null,
          history: [],
          step: 0,
          saveMessage: '',
          submitMessage: '',
          error: null
        });
        return;
      }
      const sameUser = prevUser && prevUser.sub === user.sub;
      const currentDoc = sameUser ? get().document : initialDocument();
      const nextDoc = withParticipantName(currentDoc, user);
      set({ user, document: nextDoc });
      if (!sameUser) {
        set({
          status: 'idle',
          questionnaire: null,
          responseId: null,
          latestSubmitted: null,
          lastSubmittedDocument: null,
          history: [],
          step: 0,
          saveMessage: '',
          submitMessage: '',
          error: null
        });
        resetAutoSaveState();
      }
    },
    initialize: async () => {
      const user = get().user;
      if (!user) return;
      set({ status: 'loading', error: null });
      try {
        const backend = await getSubmissionBackend();
        const questionnaire = await backend.fetchQuestionnaire(user);
        const existing = await backend.loadExisting(user, questionnaire);
        const baseDoc = withParticipantName(existing.document, user);
        const latestSubmitted = existing.latestSubmitted ? withParticipantName(existing.latestSubmitted, user) : null;
        const history = existing.completedHistory.map((entry) => ({
          ...entry,
          document: withParticipantName(entry.document, user)
        }));
        set({
          questionnaire,
          document: baseDoc,
          responseId: existing.responseId,
          latestSubmitted: latestSubmitted ?? null,
          history,
          step: 0,
          status: 'ready',
          saveMessage: '',
          submitMessage: ''
        });
      } catch (error) {
        console.error(error);
        set({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to load form'
        });
      }
    },
    updateDocument: (updater, opts) => {
      applyDocumentUpdate(updater, opts?.queueAutoSave);
    },
    setDocument: (next, opts) => {
      setDocumentInternal(next, opts?.queueAutoSave);
    },
    setStep: (step) => set({ step }),
    resetDocument: () => {
      const user = get().user;
      const doc = withParticipantName(initialDocument(), user);
      resetAutoSaveState();
      set({
        document: doc,
        step: 0,
        saveMessage: 'Form reset.',
        submitMessage: ''
      });
    },
    loadSample: async () => {
      const user = get().user;
      const sample = sampleDocument(user?.name ?? user?.sub ?? 'Sample Filer');
      const doc = withParticipantName(sample, user);
      resetAutoSaveState();
      set({
        document: doc,
        step: 0,
        saveMessage: 'Loaded sample filing.',
        submitMessage: ''
      });
      await get().saveDraft({ silent: true, document: doc });
    },
    loadFromHistory: async (responseId) => {
      const entry = get().history.find((item) => item.key === responseId);
      if (!entry) return;
      const user = get().user;
      const doc = withParticipantName(entry.document, user);
      resetAutoSaveState();
      const authored = entry.response.authored ?? entry.response.meta?.lastUpdated ?? '';
      set({
        document: doc,
        step: 0,
        saveMessage: authored ? `Loaded submission from ${formatDateTime(authored)}` : 'Loaded prior submission.',
        submitMessage: ''
      });
      await get().saveDraft({ silent: true, document: doc });
    },
    loadLatestSubmission: async () => {
      const history = get().history;
      if (history.length === 0) return;
      const latest = history[history.length - 1];
      await get().loadFromHistory(latest.key);
    },
    saveDraft: async (opts = {}) => {
      const { silent = false, document: explicitDocument } = opts;
      const { user, questionnaire } = get();
      if (!user || !questionnaire) return;
      const payloadDocument = explicitDocument ? cloneDocument(explicitDocument) : get().document;
      if (!payloadDocument) return;
      resetAutoSaveState();
      if (!silent) {
        set({ saveMessage: 'Saving…' });
      }
      try {
        const backend = await getSubmissionBackend();
        const saved = await backend.saveDraft(user, questionnaire, payloadDocument, get().responseId ?? null);
        if (!silent) {
          set({ saveMessage: `Draft saved at ${new Date().toLocaleTimeString()}` });
        }
        set({ responseId: saved.id ?? get().responseId });
      } catch (error) {
        console.error(error);
        set({ saveMessage: 'Failed to save draft.' });
        throw error;
      }
    },
    submit: async () => {
      const { user, questionnaire, document } = get();
      if (!user || !questionnaire) return 'error';
      if (!document.participant.name || !document.certificationChecked) {
        set({ submitMessage: 'Complete required fields before submitting.' });
        return 'error';
      }
      resetAutoSaveState();
      set({ status: 'submitting', submitMessage: 'Submitting…' });
      try {
        const submissionSnapshot = cloneDocument(document);
        const backend = await getSubmissionBackend();
        const saved = await backend.submit(user, questionnaire, document, get().responseId ?? null);
        set({
          responseId: saved.id ?? get().responseId,
          submitMessage: 'Filing submitted successfully.',
          lastSubmittedDocument: submissionSnapshot
        });
        await get().refreshHistory();
        set({ status: 'ready' });
        return 'success';
      } catch (error) {
        console.error(error);
        set({ submitMessage: 'Unable to submit filing.', status: 'ready' });
        return 'error';
      }
    },
    refreshHistory: async () => {
      const { user, questionnaire } = get();
      if (!user || !questionnaire) return;
      try {
        const backend = await getSubmissionBackend();
        const refreshed = await backend.loadExisting(user, questionnaire);
        const baseDoc = withParticipantName(refreshed.document, user);
        const latestSubmitted = refreshed.latestSubmitted ? withParticipantName(refreshed.latestSubmitted, user) : null;
        const history = refreshed.completedHistory.map((entry) => ({
          ...entry,
          document: withParticipantName(entry.document, user)
        }));
        set({
          document: baseDoc,
          responseId: refreshed.responseId,
          latestSubmitted: latestSubmitted ?? null,
          history
        });
      } catch (error) {
        console.error('Failed to refresh history', error);
      }
    },
    cancelAutoSave: () => {
      resetAutoSaveState();
    },
    clearMessages: () => set({ saveMessage: '', submitMessage: '' }),
    setError: (message) => set({ error: message })
  };
});

const useFinancialInterestsStore = <T,>(selector: (state: FinancialInterestsStore) => T) => useStore(financialInterestsStore, selector);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const navigate = useNavigate();

  const performPostLoginRedirect = useCallback(() => {
    const target = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    if (!target) return;
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    navigate(target, { replace: true });
  }, [navigate]);

  const establishAuthFromTokens = useCallback((tokens: StoredTokens | null) => {
    if (!tokens) {
      clearStoredTokens();
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
      clearStoredTokens();
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    const idClaims = tokens.idToken ? decodeIdToken(tokens.idToken) : null;
    const config = window.__APP_CONFIG ?? {
      fhirBaseUrl: absolutePath('./fhir'),
      oidcIssuer: null,
      oidcClientId: null,
      oidcRedirectUri: new URL('./', documentBase).toString(),
      mockAuth: true,
      staticMode: false,
      questionnaire: null,
      questionnaireResource: null
    } satisfies AppConfig;
    const sub =
      getClaim(idClaims, 'sub') ??
      'anonymous';
    const issuerCandidate =
      getClaim(idClaims, 'iss') ??
      config.oidcIssuer ??
      (config.mockAuth ? 'urn:mock' : '');
    const issuer = issuerCandidate && issuerCandidate.length > 0
      ? issuerCandidate
      : (config.mockAuth ? 'urn:mock' : (config.oidcIssuer ?? ''));
    const displayName =
      getClaim(idClaims, 'name') ??
      getClaim(idClaims, 'preferred_username') ??
      getClaim(idClaims, 'email');

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
        const config = await getAppConfig();
        if (!window.__APP_CONFIG) {
          window.__APP_CONFIG = config;
        }
        const tokens = await handleRedirect();
        if (tokens) {
          establishAuthFromTokens(tokens);
          performPostLoginRedirect();
          return;
        }
        establishAuthFromTokens(getStoredTokens());
        performPostLoginRedirect();
      } catch (error) {
        console.error('Authentication error', error);
        clearStoredTokens();
        setStatus('unauthenticated');
      }
    })();
  }, [establishAuthFromTokens, performPostLoginRedirect]);

  const login = useCallback(async () => {
    try {
      const config = await getAppConfig();
      if (!window.__APP_CONFIG) {
        window.__APP_CONFIG = config;
      }
      const relativePath = relativeToBase(window.location.pathname);
      const redirectTarget = `${relativePath}${window.location.search ?? ''}${window.location.hash ?? ''}`;
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget);
      if (config.staticMode && config.mockAuth) {
        const defaults = defaultMockClaims();
        const email = window.prompt('Mock email address', defaults.email) ?? '';
        if (!email) {
          setStatus('unauthenticated');
          return;
        }
        const name = window.prompt('Display name', defaults.name ?? email) ?? email;
        const sub = window.prompt('Subject claim (sub)', defaults.sub ?? email) ?? email;
        const claims = { ...defaults, sub, email, name } satisfies Record<string, unknown>;
        const accessToken = encodeMockClaims(claims);
        const tokens: StoredTokens = { accessToken };
        setStoredTokens(tokens);
        establishAuthFromTokens(tokens);
        performPostLoginRedirect();
        return;
      }
      if (config.mockAuth) {
        const defaults = defaultMockClaims();
        const email = window.prompt('Mock email address', defaults.email) ?? '';
        if (!email) {
          setStatus('unauthenticated');
          return;
        }
        const name = window.prompt('Display name', defaults.name ?? email) ?? email;
        const sub = window.prompt('Subject claim (sub)', defaults.sub ?? email) ?? email;
        const claims = { ...defaults, sub, email, name } satisfies Record<string, unknown>;
        await oauthStartLogin({ mockClaims: claims });
      } else {
        await oauthStartLogin();
      }
    } catch (error) {
      console.error('Login error', error);
      clearStoredTokens();
      setStatus('unauthenticated');
    }
  }, [setStatus, establishAuthFromTokens, performPostLoginRedirect]);

  const logout = useCallback(() => {
    clearStoredTokens();
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
  const basename = routerBasename === '/' ? undefined : routerBasename;
  return (
    <BrowserRouter basename={basename}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/form" element={<FormPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/submitted" element={<SubmittedPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { status, user, login, logout } = useAuth();
  const location = useLocation();
  const navIsActive = useCallback((path: string) => {
    const current = relativeToBase(location.pathname);
    if (path === '/') {
      return current === '/';
    }
    return current === path || current.startsWith(`${path}/`);
  }, [location.pathname]);
  return (
    <div>
      <header>
        <div className="container" style={{ paddingTop: 16, paddingBottom: 16 }}>
          <nav style={{ display: 'flex', gap: 16 }}>
            <NavLink to="/" label="Home" active={navIsActive('/')} />
            <NavLink to="/form" label="Financial Interests Form" active={navIsActive('/form') || navIsActive('/submitted')} />
            <NavLink to="/history" label="My History" active={navIsActive('/history')} />
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
      <main className="container" key={location.pathname} style={{ minHeight: '100vh', overflowY: 'auto' }}>
        {children}
      </main>
    </div>
  );
}

function NavLink({ to, label, active }: { to: string; label: string; active: boolean }) {
  const style = active
    ? {
        color: '#1d4ed8',
        fontWeight: 600,
        borderBottom: '2px solid #1d4ed8',
        paddingBottom: 2
      }
    : {
        color: '#1f2937',
        fontWeight: 500
      };
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} style={style}>
      {label}
    </Link>
  );
}

function Home() {
  const { status, user, login } = useAuth();
  return (
    <Layout>
      <div className="card">
        <h1>HL7 Register of Financial Interests</h1>
        <p>
          Complete your annual financial interests filing. Responses are stored as FHIR QuestionnaireResponses and can be submitted once ready.
        </p>
        {status === 'authenticated' && user ? (
          <p className="small">Welcome back, {user.name ?? user.sub}. Use the Financial Interests Form tab to continue.</p>
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

function SubmittedPage() {
  const lastSubmitted = useFinancialInterestsStore((state) => state.lastSubmittedDocument);
  const summary = useMemo(() => lastSubmitted ? formatSummaryCounts(summarizeDocumentCounts(lastSubmitted)) : null, [lastSubmitted]);
  return (
    <Layout>
      <div className="card">
        <h1>All set!</h1>
        <p className="small">Your financial interests filing has been submitted successfully.</p>
        {lastSubmitted ? (
          <>
            <div className="small" style={{ marginTop: 12 }}>{summary}</div>
            <SummaryView document={lastSubmitted} />
          </>
        ) : (
          <p className="small" style={{ marginTop: 12 }}>There is no submitted filing to display. Return to the form to submit your information.</p>
        )}
        <div style={{ marginTop: 20 }}>
          <Link className="primary" to="/form">Return to financial interests form</Link>
        </div>
      </div>
    </Layout>
  );
}

function HistoryPage() {
  const { status: authStatus, user, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const storeStatus = useFinancialInterestsStore((state) => state.status);
  const storeError = useFinancialInterestsStore((state) => state.error);
  const history = useFinancialInterestsStore((state) => state.history);
  const latestSubmitted = useFinancialInterestsStore((state) => state.latestSubmitted);
  const initialize = useFinancialInterestsStore((state) => state.initialize);
  const setStoreUser = useFinancialInterestsStore((state) => state.setUser);
  const loadFromHistory = useFinancialInterestsStore((state) => state.loadFromHistory);

  useEffect(() => {
    setStoreUser(user ?? null);
  }, [user, setStoreUser]);

  useEffect(() => {
    if (authStatus === 'authenticated' && user && storeStatus === 'idle') {
      initialize();
    }
  }, [authStatus, user, storeStatus, initialize]);

  const orderedHistory = useMemo(() => [...history].reverse(), [history]);

  useEffect(() => {
    if (orderedHistory.length === 0) return;
    const currentKey = searchParams.get('entry');
    if (!currentKey || !history.some((entry) => entry.key === currentKey)) {
      const fallbackKey = orderedHistory[0].key;
      setSearchParams({ entry: fallbackKey }, { replace: true });
    }
  }, [orderedHistory, history, searchParams, setSearchParams]);

  const selectedEntry = useMemo(() => {
    const key = searchParams.get('entry');
    if (!key) return orderedHistory[0] ?? null;
    return history.find((entry) => entry.key === key) ?? orderedHistory[0] ?? null;
  }, [searchParams, history, orderedHistory]);

  if (authStatus !== 'authenticated' || !user) {
    return (
      <Layout>
        <div className="card">
          <h1>My History</h1>
          <p className="small">You must be logged in to view your filing history.</p>
          <button className="primary" onClick={login}>Login</button>
        </div>
      </Layout>
    );
  }

  if (storeStatus === 'idle' || storeStatus === 'loading') {
    return (
      <Layout>
        <div className="card">Loading…</div>
      </Layout>
    );
  }

  if (storeStatus === 'error' && storeError) {
    return (
      <Layout>
        <div className="card">
          <h1>My History</h1>
          <p className="small">{storeError}</p>
        </div>
      </Layout>
    );
  }

  const handleLoadIntoForm = async (key: string) => {
    try {
      await loadFromHistory(key);
      navigate('/form');
    } catch (error) {
      console.error('Failed to load submission', error);
    }
  };

  const activeDoc = selectedEntry?.document ?? latestSubmitted ?? null;
  const activeAuthored = selectedEntry?.response.authored ?? selectedEntry?.response.meta?.lastUpdated ?? null;

  return (
    <Layout>
      <div className="card" style={{ marginBottom: 24 }}>
        <h1>My History</h1>
        <p className="small" style={{ marginTop: 8 }}>Review past filings and load one as a starting point for the current year.</p>
        {activeDoc && selectedEntry ? (
          <div style={{ marginTop: 16 }}>
            <div className="small" style={{ marginBottom: 12 }}>
              Filed on {activeAuthored ? formatDateTime(activeAuthored) : 'Unknown date'} • {formatSummaryCounts(summarizeDocumentCounts(activeDoc))}
            </div>
            <SummaryView document={activeDoc} />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={() => { void handleLoadIntoForm(selectedEntry.key); }}>Load into form</button>
            </div>
          </div>
        ) : (
          <p className="small" style={{ marginTop: 12 }}>You do not have any submitted filings yet.</p>
        )}
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-slate-800">All submissions</h2>
        {orderedHistory.length === 0 ? (
          <p className="small" style={{ marginTop: 8 }}>Submissions you complete will appear here.</p>
        ) : (
          <ul className="flex flex-col gap-3" style={{ marginTop: 16 }}>
            {orderedHistory.map((entry) => {
              const authored = entry.response.authored ?? entry.response.meta?.lastUpdated ?? '';
              const label = authored ? formatDateTime(authored) : 'Unknown submission';
              const summary = formatSummaryCounts(summarizeDocumentCounts(entry.document));
              const isActive = selectedEntry?.key === entry.key;
              return (
                <li
                  key={entry.key}
                  className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3"
                  style={isActive ? { borderColor: '#1d4ed8', backgroundColor: '#eef2ff', boxShadow: 'inset 0 0 0 1px rgba(29,78,216,0.2)' } : undefined}
                >
                  <div className="min-w-0" style={{ flex: '1 1 auto' }}>
                    <Link to={{ pathname: '/history', search: `entry=${encodeURIComponent(entry.key)}` }} className="font-medium text-slate-800" aria-current={isActive ? 'page' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span>{label}</span>
                    </Link>
                    <div className="small">{summary}</div>
                  </div>
                  <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                    <Link className="secondary" to={{ pathname: '/history', search: `entry=${encodeURIComponent(entry.key)}` }} aria-current={isActive ? 'page' : undefined}>View</Link>
                    <button className="ghost" onClick={() => { void handleLoadIntoForm(entry.key); }}>Load into form</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Layout>
  );
}

function FormPage() {
  const { status: authStatus, user, login } = useAuth();
  const navigate = useNavigate();
  const storeStatus = useFinancialInterestsStore((state) => state.status);
  const storeError = useFinancialInterestsStore((state) => state.error);
  const document = useFinancialInterestsStore((state) => state.document);
  const questionnaire = useFinancialInterestsStore((state) => state.questionnaire);
  const step = useFinancialInterestsStore((state) => state.step);
  const setStep = useFinancialInterestsStore((state) => state.setStep);
  const updateDocument = useFinancialInterestsStore((state) => state.updateDocument);
  const loadSample = useFinancialInterestsStore((state) => state.loadSample);
  const loadLatestSubmission = useFinancialInterestsStore((state) => state.loadLatestSubmission);
  const loadFromHistory = useFinancialInterestsStore((state) => state.loadFromHistory);
  const submit = useFinancialInterestsStore((state) => state.submit);
  const saveMessage = useFinancialInterestsStore((state) => state.saveMessage);
  const submitMessage = useFinancialInterestsStore((state) => state.submitMessage);
  const history = useFinancialInterestsStore((state) => state.history);
  const canAdvanceIntro = useFinancialInterestsStore((state) => state.canAdvanceIntro());
  const summaryText = useFinancialInterestsStore((state) => state.summaryText());
  const initialize = useFinancialInterestsStore((state) => state.initialize);
  const setStoreUser = useFinancialInterestsStore((state) => state.setUser);

  useEffect(() => {
    setStoreUser(user ?? null);
  }, [user, setStoreUser]);

  useEffect(() => {
    if (authStatus === 'authenticated' && user && storeStatus === 'idle') {
      initialize();
    }
  }, [authStatus, user, storeStatus, initialize]);

  const steps = wizardSteps;
  const historyList = useMemo(() => [...history].reverse(), [history]);
  const submitDisabled = !document.participant.name || !document.certificationChecked;
  const loading = authStatus === 'authenticated' && (storeStatus === 'idle' || storeStatus === 'loading');

  if (authStatus !== 'authenticated' || !user) {
    return (
      <Layout>
        <div className="card">
          <h1>Financial Interests Form</h1>
          <p className="small">You must be logged in to edit your filing.</p>
          <button className="primary" onClick={login}>Login</button>
        </div>
      </Layout>
    );
  }

  if (loading || !questionnaire) {
    return (
      <Layout>
        <div className="card">Loading…</div>
      </Layout>
    );
  }

  if (storeStatus === 'error' && storeError) {
    return (
      <Layout>
        <div className="card">
          <h1>Error</h1>
          <p className="small">{storeError}</p>
        </div>
      </Layout>
    );
  }

  const renderNavigationCard = (prevStep: number | null, nextStep: number | null, options: { nextLabel?: string; nextDisabled?: boolean } = {}) => (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        {prevStep !== null ? (
          <button className="ghost" onClick={() => setStep(prevStep)}>Back</button>
        ) : <span />}
      </div>
      {nextStep !== null ? (
        <button
          className="primary"
          disabled={options.nextDisabled}
          onClick={() => setStep(nextStep)}
        >
          {options.nextLabel ?? 'Next'}
        </button>
      ) : <span />}
    </div>
  );

  return (
    <Layout>
      <div className="card">
        <div className="stepHeader" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <h1>Financial Interests Form</h1>
            <p className="small">
              Step {step + 1} of {steps.length}
              {step === steps.length - 1 ? ` • ${summaryText}` : ''}
            </p>
          </div>
        </div>
        {saveMessage && <div className="small" style={{ marginTop: 12 }}>{saveMessage}</div>}
        <ol className="stepper" style={{ marginTop: 16 }}>
          {steps.map((wizardStep, idx) => {
            const isActive = wizardStep.id === step;
            return (
              <li key={wizardStep.id}>
                <button
                  onClick={() => setStep(wizardStep.id)}
                  aria-current={isActive ? 'step' : undefined}
                  style={isActive ? {
                    backgroundColor: '#eef2ff',
                    borderColor: '#1d4ed8',
                    color: '#1d4ed8',
                    boxShadow: 'inset 0 -3px 0 0 rgba(29, 78, 216, 0.35)',
                    fontWeight: 600
                  } : undefined}
                >
                  <span className="badge">{idx + 1}</span>
                  <span>{wizardStep.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {step === 0 && (
        <>
          <div className="space-y-6">
            {historyList.length > 0 ? (
              <HistoryCard
                history={historyList}
                onLoad={(key) => {
                  void loadFromHistory(key);
                }}
              />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">Sample submission</h3>
                <p className="small" style={{ marginTop: 8 }}>Need an example to get started? Load a sample filing and edit from there.</p>
                <button className="secondary" style={{ marginTop: 16 }} onClick={() => { void loadSample(); }}>Load sample submission</button>
              </div>
            )}
            <ParticipantSection document={document} updateDocument={updateDocument} />
          </div>
          {renderNavigationCard(null, 1, { nextDisabled: !canAdvanceIntro })}
        </>
      )}

      {step === 1 && (
        <>
          <RolesSection document={document} updateDocument={updateDocument} />
          {renderNavigationCard(0, 2)}
        </>
      )}

      {step === 2 && (
        <>
          <FinancialSection document={document} updateDocument={updateDocument} />
          {renderNavigationCard(1, 3)}
        </>
      )}

      {step === 3 && (
        <>
          <OwnershipSection document={document} updateDocument={updateDocument} />
          {renderNavigationCard(2, 4)}
        </>
      )}

      {step === 4 && (
        <>
          <GiftsSection document={document} updateDocument={updateDocument} />
          {renderNavigationCard(3, 5)}
        </>
      )}

      {step === 5 && (
        <>
          <div className="card">
            <h2>Review & submit</h2>
            <p className="small">Summary: {summaryText}</p>
            <SummaryView document={document} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginTop: 20 }}>
              <button className="ghost" onClick={() => setStep(4)}>Back</button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end' }}>
                <label className="inline-flex items-start gap-2 text-sm text-slate-700" style={{ maxWidth: 320, textAlign: 'left' }}>
                  <input
                    type="checkbox"
                    checked={document.certificationChecked}
                    onChange={(e) => updateDocument((doc) => ({
                      ...doc,
                      certificationChecked: e.target.checked
                    }))}
                  />
                  <span>I certify these financial interests meet HL7 thresholds and consent to public posting.</span>
                </label>
                <button
                  className="primary"
                  disabled={submitDisabled || storeStatus === 'submitting'}
                  onClick={async () => {
                    const result = await submit();
                    if (result === 'success') {
                      navigate('/submitted');
                    }
                  }}
              >
                Submit filing
              </button>
            </div>
            </div>
            {submitMessage && (
              <div className="small" style={{ marginTop: 16 }}>{submitMessage}</div>
            )}
          </div>
        </>
      )}
    </Layout>
  );
}

type SectionProps = {
  document: FinancialInterestsDocument;
  updateDocument: (fn: (current: FinancialInterestsDocument) => FinancialInterestsDocument) => void;
};

function ParticipantSection({ document, updateDocument }: SectionProps) {
  const participant = document.participant;
  const displayName = participant.name;
  return (
    <div className="card">
      <h2>Participant</h2>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <span className={fieldLabelClass}>Full name (from your HL7 account)</span>
          <input
            type="text"
            value={displayName}
            readOnly
            disabled
            className={`${fieldInputClass} bg-slate-100`}
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <span className={fieldLabelClass}>HL7 roles (public)</span>
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
            className={`${selectInputClass} h-40`}
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
        </div>
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
          primaryEmployer: false
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
          <p className="small">Include primary employer and governance/advisory roles meeting the financial interest threshold.</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {document.roles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-sm text-slate-600">
            No roles added yet.
          </div>
        ) : null}
        {document.roles.map((role, idx) => (
          <div
            key={idx}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
            style={{ marginBottom: idx === document.roles.length - 1 ? 0 : sectionCardGap }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-base font-semibold text-slate-800">Role {idx + 1}</div>
              <button className="ghost text-sm" onClick={() => removeRole(idx)}>Remove</button>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity name</span>
                <input
                  value={role.entityName}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, entityName: e.target.value } : r))
                  }))}
                  className={fieldInputClass}
                />
              </div>
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity type</span>
                <select
                  value={role.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, entityType: e.target.value as EntityType } : r))
                  }))}
                  className={selectInputClass}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="university">University</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <span className={fieldLabelClass}>Role / Title</span>
                <input
                  value={role.role}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, role: e.target.value } : r))
                  }))}
                  className={fieldInputClass}
                />
              </div>
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={role.primaryEmployer}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, primaryEmployer: e.target.checked, paid: e.target.checked || r.paid } : r))
                  }))}
                  className={checkboxInputClass}
                />
                Primary employer
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={role.paid}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    roles: doc.roles.map((r, i) => (i === idx ? { ...r, paid: e.target.checked } : r))
                  }))}
                  className={checkboxInputClass}
                />
                Paid role
              </label>
            </div>
          </div>
        ))}
        <div className="flex justify-end" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={addRole}>Add role</button>
        </div>
      </div>
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
          <p className="small">Report sources meeting the HL7 financial interest threshold in the prior 12 months.</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {document.financial.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-sm text-slate-600">
            No funding sources listed.
          </div>
        ) : null}
        {document.financial.map((entry, idx) => (
          <div
            key={idx}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
            style={{ marginBottom: idx === document.financial.length - 1 ? 0 : sectionCardGap }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-base font-semibold text-slate-800">Source {idx + 1}</div>
              <button className="ghost text-sm" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <span className={fieldLabelClass}>Funding source</span>
                <input
                  value={entry.fundingSource}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, fundingSource: e.target.value } : f))
                  }))}
                  className={fieldInputClass}
                />
              </div>
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity type</span>
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, entityType: e.target.value as EntityType } : f))
                  }))}
                  className={selectInputClass}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="university">University</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={entry.passThrough}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    financial: doc.financial.map((f, i) => (i === idx ? { ...f, passThrough: e.target.checked } : f))
                  }))}
                  className={checkboxInputClass}
                />
                Paid via intermediary
              </label>
              {entry.passThrough ? (
                <div className="space-y-2 md:col-span-2">
                  <span className={fieldLabelClass}>Intermediary</span>
                  <input
                    value={entry.intermediary}
                    onChange={(e) => updateDocument((doc) => ({
                      ...doc,
                      financial: doc.financial.map((f, i) => (i === idx ? { ...f, intermediary: e.target.value } : f))
                    }))}
                    className={fieldInputClass}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ))}
        <div className="flex justify-end" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={addEntry}>Add source</button>
        </div>
      </div>
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
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {document.ownerships.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-sm text-slate-600">
            No ownership interests listed.
          </div>
        ) : null}
        {document.ownerships.map((entry, idx) => (
          <div
            key={idx}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
            style={{ marginBottom: idx === document.ownerships.length - 1 ? 0 : sectionCardGap }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-base font-semibold text-slate-800">Ownership {idx + 1}</div>
              <button className="ghost text-sm" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity name</span>
                <input
                  value={entry.entityName}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, entityName: e.target.value } : o))
                  }))}
                  className={fieldInputClass}
                />
              </div>
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity type</span>
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, entityType: e.target.value as EntityType } : o))
                  }))}
                  className={selectInputClass}
                >
                  <option value="public">Publicly traded</option>
                  <option value="private">Privately held</option>
                  <option value="llc">Partnership / LLC</option>
                  <option value="nonprofit">Nonprofit / Other</option>
                </select>
              </div>
              <div className="space-y-2">
                <span className={fieldLabelClass}>Ownership tier</span>
                <select
                  value={entry.tier}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    ownerships: doc.ownerships.map((o, i) => (i === idx ? { ...o, tier: e.target.value as OwnershipInterest['tier'] } : o))
                  }))}
                  className={selectInputClass}
                >
                  <option value="1-5%">1–5%</option>
                  <option value=">5%">&gt;5%</option>
                </select>
              </div>
            </div>
          </div>
        ))}
        <div className="flex justify-end" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={addEntry}>Add ownership</button>
        </div>
      </div>
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
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {document.gifts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-sm text-slate-600">
            No entries yet.
          </div>
        ) : null}
        {document.gifts.map((entry, idx) => (
          <div
            key={idx}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
            style={{ marginBottom: idx === document.gifts.length - 1 ? 0 : sectionCardGap }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-base font-semibold text-slate-800">Sponsor {idx + 1}</div>
              <button className="ghost text-sm" onClick={() => removeEntry(idx)}>Remove</button>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <span className={fieldLabelClass}>Sponsor</span>
                <input
                  value={entry.sponsor}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    gifts: doc.gifts.map((g, i) => (i === idx ? { ...g, sponsor: e.target.value } : g))
                  }))}
                  className={fieldInputClass}
                />
              </div>
              <div className="space-y-2">
                <span className={fieldLabelClass}>Entity type</span>
                <select
                  value={entry.entityType}
                  onChange={(e) => updateDocument((doc) => ({
                    ...doc,
                    gifts: doc.gifts.map((g, i) => (i === idx ? { ...g, entityType: e.target.value as EntityType } : g))
                  }))}
                  className={selectInputClass}
                >
                  <option value="for_profit">For-profit</option>
                  <option value="nonprofit">Nonprofit</option>
                  <option value="government">Government</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
          </div>
        ))}
        <div className="flex justify-end" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={addEntry}>Add sponsor</button>
        </div>
      </div>
    </div>
  );
}

function HistoryCard({ history, onLoad }: { history: CompletedHistoryEntry[]; onLoad: (key: string) => void | Promise<void> }) {
  if (history.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Previous submissions</h2>
        <p className="small" style={{ marginTop: 6 }}>Select a prior submission to load it as a starting point for this year.</p>
      </div>
      <ul className="flex flex-col gap-3">
        {history.map((entry, idx) => {
          const authored = entry.response.authored ?? entry.response.meta?.lastUpdated ?? '';
          const label = authored ? formatDateTime(authored) : `Submission ${history.length - idx}`;
          const counts = summarizeDocumentCounts(entry.document);
          const summary = formatSummaryCounts(counts);
          const key = entry.key || `${idx}-${label}`;
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium text-slate-800">{label}</div>
                <div className="small">{summary}</div>
              </div>
              <button className="secondary" onClick={() => { void onLoad(key); }}>Load submission</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SummaryView({ document }: { document: FinancialInterestsDocument }) {
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

function initialDocument(): FinancialInterestsDocument {
  return {
    recordYear: new Date().getFullYear(),
    participant: { name: '', hl7Roles: [] },
    roles: [],
    financial: [],
    ownerships: [],
    gifts: [],
    certificationChecked: false
  };
}

function sampleDocument(name: string): FinancialInterestsDocument {
  return {
    recordYear: new Date().getFullYear(),
    participant: {
      name,
      hl7Roles: ['Board', 'TSC']
    },
    roles: [
      {
        entityName: 'Vanta Clinical Platforms',
        entityType: 'for_profit',
        role: 'Chief Standards Strategist',
        paid: true,
        primaryEmployer: true
      },
      {
        entityName: 'Nimbus Interop Cooperative',
        entityType: 'nonprofit',
        role: 'Program Advisor',
        paid: false,
        primaryEmployer: false
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

function deriveDisplayName(user: AuthenticatedUser | null): string {
  return user?.name ?? user?.sub ?? '';
}

function withParticipantName(document: FinancialInterestsDocument, user: AuthenticatedUser | null): FinancialInterestsDocument {
  const result = cloneDocument(document);
  const displayName = deriveDisplayName(user);
  if (displayName) {
    result.participant.name = displayName;
  }
  return result;
}

function cloneDocument(source: FinancialInterestsDocument): FinancialInterestsDocument {
  return {
    recordYear: source.recordYear,
    participant: {
      name: source.participant.name,
      hl7Roles: [...source.participant.hl7Roles]
    },
    roles: source.roles.map((role) => ({ ...role })),
    financial: source.financial.map((entry) => ({ ...entry })),
    ownerships: source.ownerships.map((entry) => ({ ...entry })),
    gifts: source.gifts.map((entry) => ({ ...entry })),
    certificationChecked: source.certificationChecked
  };
}

type FhirBundle<T> = {
  entry?: { resource?: T }[];
};

async function canonicalFromQuestionnaire(questionnaire: Questionnaire): Promise<string> {
  const config = await getAppConfig();
  const url = questionnaire.url ?? config.questionnaire?.url ?? '';
  const version = questionnaire.version ?? config.questionnaire?.version;
  return version ? `${url}|${version}` : url;
}

class FhirSubmissionBackend implements SubmissionBackend {
  async fetchQuestionnaire(user: AuthenticatedUser): Promise<Questionnaire> {
    const config = await getAppConfig();
    const canonical = config.questionnaire ?? { url: '', version: '' };
    const search = new URLSearchParams();
    if (canonical.url) search.set('url', canonical.url);
    if (canonical.version) search.set('version', canonical.version);
    search.set('_count', '1');
    const res = await this.fhirFetch(`/Questionnaire?${search.toString()}`, user.accessToken);
    const bundle = await res.json() as { entry?: { resource?: Questionnaire }[] };
    const questionnaire = bundle.entry?.[0]?.resource;
    if (!questionnaire) throw new Error('Questionnaire not found');
    return questionnaire;
  }

  async loadExisting(user: AuthenticatedUser, questionnaire: Questionnaire): Promise<ExistingResponseLoad> {
    const canonical = await canonicalFromQuestionnaire(questionnaire);
    const searchDraft = new URLSearchParams();
    searchDraft.set('subject:identifier', `${user.subjectSystem}|${user.sub}`);
    searchDraft.set('questionnaire', canonical);
    searchDraft.set('status', 'in-progress');
    searchDraft.set('_count', '5');
    const draftRes = await this.fhirFetch(`/QuestionnaireResponse?${searchDraft.toString()}`, user.accessToken);
    const draftBundle = await draftRes.json() as FhirBundle<QuestionnaireResponse>;
    const draftList = (draftBundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is QuestionnaireResponse => Boolean(resource))
      .sort((a, b) => {
        const authoredA = Date.parse(a?.authored ?? '') || 0;
        const authoredB = Date.parse(b?.authored ?? '') || 0;
        return authoredB - authoredA;
      });
    let draft = draftList[0] ?? null;

    const searchCompleted = new URLSearchParams();
    searchCompleted.set('subject:identifier', `${user.subjectSystem}|${user.sub}`);
    searchCompleted.set('questionnaire', canonical);
    searchCompleted.set('status', 'completed');
    searchCompleted.set('_count', '50');
    const completedRes = await this.fhirFetch(`/QuestionnaireResponse?${searchCompleted.toString()}`, user.accessToken);
    const completedBundle = await completedRes.json() as FhirBundle<QuestionnaireResponse>;
    const completedList = (completedBundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is QuestionnaireResponse => Boolean(resource));

    const completedHistory = completedList
      .map((response, index) => {
        const document = questionnaireResponseToDocument(questionnaire, response);
        const key = response.id
          ?? response.meta?.lastUpdated
          ?? response.authored
          ?? `history-${index}`;
        return {
          key,
          response,
          document
        } satisfies CompletedHistoryEntry;
      })
      .sort((a, b) => {
        const authoredA = Date.parse(a.response.authored ?? '') || 0;
        const authoredB = Date.parse(b.response.authored ?? '') || 0;
        return authoredA - authoredB;
      });

    const latestCompleted = completedHistory.length > 0 ? completedHistory[completedHistory.length - 1] : null;
    const baseDocument = draft
      ? questionnaireResponseToDocument(questionnaire, draft)
      : latestCompleted
      ? latestCompleted.document
      : initialDocument();

    if (!draft) {
      draft = await this.createDraftQuestionnaireResponse(user, questionnaire, baseDocument);
    }

    return {
      document: cloneDocument(baseDocument),
      responseId: draft.id ?? null,
      latestSubmitted: latestCompleted ? cloneDocument(latestCompleted.document) : undefined,
      completedHistory: completedHistory.map((entry) => ({
        key: entry.key,
        response: entry.response,
        document: cloneDocument(entry.document)
      }))
    };
  }

  async saveDraft(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse> {
    const payload = await documentToQuestionnaireResponse(questionnaire, document, 'in-progress');
    this.applySubject(payload, user);
    return this.upsertQuestionnaireResponse(user.accessToken, payload, responseId ?? undefined);
  }

  async submit(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse> {
    const payload = await documentToQuestionnaireResponse(questionnaire, document, 'completed');
    this.applySubject(payload, user);
    return this.upsertQuestionnaireResponse(user.accessToken, payload, responseId ?? undefined);
  }

  private applySubject(payload: QuestionnaireResponse, user: AuthenticatedUser) {
    payload.subject = {
      identifier: {
        system: user.subjectSystem,
        value: user.sub
      },
      display: deriveDisplayName(user)
    };
  }

  private async createDraftQuestionnaireResponse(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument
  ) {
    const payload = await documentToQuestionnaireResponse(questionnaire, document, 'in-progress');
    this.applySubject(payload, user);
    return this.upsertQuestionnaireResponse(user.accessToken, payload);
  }

  private async upsertQuestionnaireResponse(
    accessToken: string,
    payload: QuestionnaireResponse,
    existingId?: string
  ): Promise<QuestionnaireResponse> {
    const method = existingId ? 'PUT' : 'POST';
    const path = existingId ? `/QuestionnaireResponse/${existingId}` : '/QuestionnaireResponse';
    const res = await this.fhirFetch(path, accessToken, {
      method,
      body: JSON.stringify(payload)
    });
    return (await res.json()) as QuestionnaireResponse;
  }

  private async fhirFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
    const config = await getAppConfig();
    const base = config.fhirBaseUrl.replace(/\/$/, '');
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
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
}

type StaticStoredResponse = {
  id: string;
  authored: string;
  response: QuestionnaireResponse;
};

type StaticStore = {
  drafts: Record<string, StaticStoredResponse>;
  submissions: Record<string, StaticStoredResponse[]>;
};

class StaticSubmissionBackend implements SubmissionBackend {
  async fetchQuestionnaire(_user: AuthenticatedUser): Promise<Questionnaire> {
    const config = await getAppConfig();
    const resource = config.questionnaireResource;
    if (resource && typeof resource === 'object') {
      return this.cloneQuestionnaire(resource as Questionnaire);
    }
    throw new Error('Static mode requires questionnaireResource in app config');
  }

  async loadExisting(user: AuthenticatedUser, questionnaire: Questionnaire): Promise<ExistingResponseLoad> {
    const canonical = await canonicalFromQuestionnaire(questionnaire);
    const store = this.readStore(user);
    const draftEntry = await this.ensureDraft(user, questionnaire, store, canonical);
    const baseDocument = questionnaireResponseToDocument(questionnaire, draftEntry.response);

    const submissions = [...(store.submissions[canonical] ?? [])].sort((a, b) => {
      const aTime = Date.parse(a.authored) || 0;
      const bTime = Date.parse(b.authored) || 0;
      return aTime - bTime;
    });

    const completedHistory = submissions.map((entry, index) => {
      const response = this.cloneResponse(entry.response);
      const document = questionnaireResponseToDocument(questionnaire, response);
      const key = response.id ?? response.meta?.lastUpdated ?? response.authored ?? `history-${index}`;
      return {
        key,
        response,
        document: cloneDocument(document)
      } satisfies CompletedHistoryEntry;
    });

    const latestSubmitted = completedHistory.length > 0
      ? cloneDocument(completedHistory[completedHistory.length - 1].document)
      : undefined;

    return {
      document: cloneDocument(baseDocument),
      responseId: draftEntry.response.id ?? null,
      latestSubmitted,
      completedHistory
    };
  }

  async saveDraft(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse> {
    const canonical = await canonicalFromQuestionnaire(questionnaire);
    const store = this.readStore(user);
    const payload = await documentToQuestionnaireResponse(questionnaire, document, 'in-progress');
    this.applySubject(payload, user);
    const id = responseId ?? payload.id ?? this.generateId();
    payload.id = id;
    const timestamp = new Date().toISOString();
    payload.authored = timestamp;
    payload.meta = { ...(payload.meta ?? {}), lastUpdated: timestamp };
    store.drafts[canonical] = {
      id,
      authored: timestamp,
      response: this.cloneResponse(payload)
    };
    this.writeStore(user, store);
    return this.cloneResponse(payload);
  }

  async submit(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    document: FinancialInterestsDocument,
    responseId: string | null
  ): Promise<QuestionnaireResponse> {
    const canonical = await canonicalFromQuestionnaire(questionnaire);
    const store = this.readStore(user);
    const payload = await documentToQuestionnaireResponse(questionnaire, document, 'completed');
    this.applySubject(payload, user);
    const id = responseId ?? payload.id ?? this.generateId();
    payload.id = id;
    const timestamp = new Date().toISOString();
    payload.authored = timestamp;
    payload.meta = { ...(payload.meta ?? {}), lastUpdated: timestamp };
    const storedResponse: StaticStoredResponse = {
      id,
      authored: timestamp,
      response: this.cloneResponse(payload)
    };
    const submissions = store.submissions[canonical] ?? [];
    submissions.push(storedResponse);
    store.submissions[canonical] = submissions;
    delete store.drafts[canonical];
    this.writeStore(user, store);
    return this.cloneResponse(payload);
  }

  private applySubject(payload: QuestionnaireResponse, user: AuthenticatedUser) {
    payload.subject = {
      identifier: {
        system: user.subjectSystem,
        value: user.sub
      },
      display: deriveDisplayName(user)
    };
  }

  private async ensureDraft(
    user: AuthenticatedUser,
    questionnaire: Questionnaire,
    store: StaticStore,
    canonical: string
  ): Promise<StaticStoredResponse> {
    const existing = store.drafts[canonical];
    if (existing) return existing;
    const document = initialDocument();
    const response = await documentToQuestionnaireResponse(questionnaire, document, 'in-progress');
    this.applySubject(response, user);
    const id = this.generateId();
    const timestamp = new Date().toISOString();
    response.id = id;
    response.authored = timestamp;
    response.meta = { ...(response.meta ?? {}), lastUpdated: timestamp };
    const stored: StaticStoredResponse = {
      id,
      authored: timestamp,
      response: this.cloneResponse(response)
    };
    store.drafts[canonical] = stored;
    this.writeStore(user, store);
    return stored;
  }

  private readStore(user: AuthenticatedUser): StaticStore {
    try {
      const raw = localStorage.getItem(this.storageKey(user));
      if (!raw) {
        return { drafts: {}, submissions: {} };
      }
      const parsed = JSON.parse(raw) as Partial<StaticStore> | null;
      return {
        drafts: parsed?.drafts ?? {},
        submissions: parsed?.submissions ?? {}
      };
    } catch {
      return { drafts: {}, submissions: {} };
    }
  }

  private writeStore(user: AuthenticatedUser, store: StaticStore) {
    localStorage.setItem(this.storageKey(user), JSON.stringify(store));
  }

  private storageKey(user: AuthenticatedUser): string {
    return `fi.static.v1::${user.subjectSystem}|${user.sub}`;
  }

  private cloneResponse(response: QuestionnaireResponse): QuestionnaireResponse {
    if (typeof structuredClone === 'function') {
      return structuredClone(response);
    }
    return JSON.parse(JSON.stringify(response)) as QuestionnaireResponse;
  }

  private cloneQuestionnaire(questionnaire: Questionnaire): Questionnaire {
    if (typeof structuredClone === 'function') {
      return structuredClone(questionnaire);
    }
    return JSON.parse(JSON.stringify(questionnaire)) as Questionnaire;
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function questionnaireResponseToDocument(questionnaire: Questionnaire, response: QuestionnaireResponse): FinancialInterestsDocument {
  const doc = initialDocument();
  const items = response.item ?? [];
  const participantGroup = findItem(items, 'participant');
  const subjectName = response.subject?.display ?? '';
  if (subjectName) {
    doc.participant.name = subjectName;
  }
  if (participantGroup) {
    if (!doc.participant.name) {
      const fallbackName = getString(participantGroup, 'participant.name');
      if (fallbackName) {
        doc.participant.name = fallbackName;
      }
    }
    doc.participant.hl7Roles = getCodingList(participantGroup, 'participant.hl7Roles');
  }
  const roleGroups = findItems(items, 'roles');
  doc.roles = roleGroups.map((group) => ({
    entityName: getString(group, 'roles.entityName'),
    entityType: (getCoding(group, 'roles.entityType') as EntityType) || 'for_profit',
    role: getString(group, 'roles.role'),
    paid: getBoolean(group, 'roles.paid'),
    primaryEmployer: getBoolean(group, 'roles.primaryEmployer')
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
    tier: (getCoding(group, 'ownerships.tier') as OwnershipInterest['tier']) || '1-5%'
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

async function documentToQuestionnaireResponse(questionnaire: Questionnaire, document: FinancialInterestsDocument, status: 'in-progress' | 'completed'): Promise<QuestionnaireResponse> {
  const canonical = await canonicalFromQuestionnaire(questionnaire);
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
    item: (template.item ?? [])
      .map((child) => {
        if (child.linkId === 'participant.hl7Roles') {
          return answerItem(child, participant.hl7Roles.map((code) => ({ valueCoding: { code, display: code } })));
        }
        return null;
      })
      .filter((child): child is QuestionnaireResponseItem => Boolean(child))
  };
}

function buildRoleItem(template: QuestionnaireItem, role: RoleInterest): QuestionnaireResponseItem {
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
        default:
          return answerItem(child, []);
      }
    })
  };
}

function buildFinancialItem(template: QuestionnaireItem, entry: FundingInterest): QuestionnaireResponseItem {
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

function buildOwnershipItem(template: QuestionnaireItem, entry: OwnershipInterest): QuestionnaireResponseItem {
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

function buildGiftItem(template: QuestionnaireItem, entry: GiftInterest): QuestionnaireResponseItem {
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

function findQuestionnaireItem(items: QuestionnaireItem[], linkId: string): QuestionnaireItem | undefined {
  return items.find((item) => item.linkId === linkId);
}

function decodeIdToken(idToken: string): Record<string, any> | null {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    const decoded = JSON.parse(decodeBase64Url(payload));
    return decoded as Record<string, any>;
  } catch (error) {
    console.error('Failed to decode ID token payload', error);
    return null;
  }
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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
