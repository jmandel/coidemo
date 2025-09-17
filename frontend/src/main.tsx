import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useParams } from 'react-router-dom';
import './styles.css';

import type {
  DisclosureDocument,
  DisclosureDraft,
  DisclosureRecord,
  DisclosureSnapshot,
  RoleDisclosure,
  FinancialDisclosure,
  OwnershipDisclosure,
  GiftDisclosure
} from '../../src/disclosure_types';

function useMe() {
  const [data, setData] = useState<any>(null);
  const refresh = useCallback(() => {
    fetch('/api/me', { credentials: 'include' }).then(async (r) => {
      if (r.status === 401) {
        setData({ user: null });
        return;
      }
      setData(await r.json());
    });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { data, refresh };
}

function useMeta() {
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => {
    fetch('/api/meta').then(async (r) => {
      try {
        setMeta(await r.json());
      } catch {
        setMeta({});
      }
    }).catch(() => setMeta({}));
  }, []);
  return meta;
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

const initialDocument = (): DisclosureDocument => ({
  recordYear: new Date().getFullYear(),
  participant: { name: '', email: '', hl7Roles: [], consentPublic: false },
  roles: [
    {
      entityName: '',
      entityType: 'for_profit',
      role: '',
      paid: false,
      primaryEmployer: false,
      aboveThreshold: null,
    }
  ],
  financial: [
    {
      fundingSource: '',
      entityType: 'for_profit',
      passThrough: false,
      intermediary: ''
    }
  ],
  ownerships: [],
  gifts: [],
  certificationChecked: false
});

const steps = [
  { id: 0, title: 'Intro' },
  { id: 1, title: 'Roles' },
  { id: 2, title: 'Funding' },
  { id: 3, title: 'Ownership' },
  { id: 4, title: 'Gifts / Travel' },
  { id: 5, title: 'Review & Submit' }
];

type PublicProfileSummary = {
  hl7_id: string;
  name: string;
  org_role: string;
  last_submitted_at: string | null;
  counts: {
    roles: number;
    financial: number;
    ownerships: number;
    gifts: number;
  };
  history_count: number;
};

type PublicHistoryEntry = {
  id: string;
  submittedAt: string;
  counts: {
    roles: number;
    financial: number;
    ownerships: number;
    gifts: number;
  };
};

type PublicDisclosureDetail = {
  user: { hl7_id: string; name: string; org_role: string };
  latest: { submittedAt: string; document: DisclosureDocument; counts: PublicHistoryEntry['counts'] } | null;
  history: PublicHistoryEntry[];
};

type PublicSnapshotDetail = {
  user: { hl7_id: string; name: string; org_role: string };
  submission: { submittedAt: string; document: DisclosureDocument; counts: PublicHistoryEntry['counts'] };
};

function summarizeDocumentCounts(doc: DisclosureDocument) {
  return {
    roles: doc.roles.length,
    financial: doc.financial.length,
    ownerships: doc.ownerships.length,
    gifts: doc.gifts.length
  };
}

function formatSummaryText(counts: { roles: number; financial: number; ownerships: number; gifts: number }) {
  return [
    `${counts.roles} role${counts.roles === 1 ? '' : 's'}`,
    `${counts.financial} funding source${counts.financial === 1 ? '' : 's'}`,
    `${counts.ownerships} ownership${counts.ownerships === 1 ? '' : 's'}`,
    `${counts.gifts} gift/travel item${counts.gifts === 1 ? '' : 's'}`
  ].join(' • ');
}

function normalizeDocument(doc: DisclosureDocument): DisclosureDocument {
  const roles = Array.isArray(doc.participant.hl7Roles)
    ? doc.participant.hl7Roles.map((role) => role.trim()).filter(Boolean)
    : [];
  const normalizedRoles = Array.isArray(doc.roles) ? doc.roles.map((role) => ({
    ...role,
    aboveThreshold: role.aboveThreshold ?? null
  })) : [];
  return {
    ...doc,
    participant: {
      ...doc.participant,
      hl7Roles: roles
    },
    roles: normalizedRoles
  };
}

function deriveIntermediarySelectValue(roles: RoleDisclosure[], intermediary: string) {
  if (!intermediary) return '__custom';
  return roles.some((role) => role.entityName === intermediary) ? intermediary : '__custom';
}

function COIForm() {
  const { data: me, refresh } = useMe();
  const userId = me?.user?.id ?? null;
  const draftKey = userId ? `coi-draft-${userId}` : null;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<DisclosureDocument>(initialDocument);
  const [record, setRecord] = useState<DisclosureRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginRequired, setLoginRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [submitMessage, setSubmitMessage] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const copyTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const unauthenticated = loginRequired || me?.user === null;


  useEffect(() => {
    if (me === null) return;
    if (!me.user) {
      setLoginRequired(true);
      setLoading(false);
      setRecord(null);
      setForm(initialDocument());
      return;
    }
    setLoginRequired(false);
    setLoading(true);
    fetch('/api/disclosure', { credentials: 'include' }).then(async (r) => {
      if (r.status === 401) {
        setLoginRequired(true);
        setLoading(false);
        refresh();
        return;
      }
      const js = await r.json() as { disclosure: DisclosureRecord };
      setRecord(js.disclosure);
      const latest = js.disclosure.draft?.document ?? null;
      if (latest) {
        const normalized = normalizeDocument(latest);
        setForm(normalized);
      } else {
        setForm(initialDocument());
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [me, refresh]);

  useEffect(() => {
    if (!draftKey) return;
    const stored = localStorage.getItem(draftKey);
    if (!stored) {
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      const normalized = normalizeDocument(parsed);
      setForm(normalized);
    } catch {
    }
  }, [draftKey]);

  const saveDraft = useCallback(async (explicitDocument?: DisclosureDocument) => {
    if (!draftKey) return;
    setSaving(true);
    const payload = explicitDocument ?? form;
    localStorage.setItem(draftKey, JSON.stringify(payload));
    const res = await fetch('/api/disclosure', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ document: payload })
    });
    const js = await res.json();
    setRecord(js.disclosure);
    setSaving(false);
    setSaveMessage('Saved ' + new Date().toLocaleTimeString());
  }, [form, draftKey]);

  useEffect(() => {
    if (loading || loginRequired) return;
    const handle = setTimeout(() => {
      saveDraft();
    }, 1500);
    return () => clearTimeout(handle);
  }, [form, loading, loginRequired, saveDraft]);

  const resetForm = () => {
    if (draftKey) localStorage.removeItem(draftKey);
    setForm(initialDocument());
    setStep(0);
  };

  const loadLastSubmission = () => {
    if (!record || !record.history || record.history.length === 0) return;
    const latestSnap = record.history[record.history.length - 1];
    const normalized = { ...normalizeDocument(latestSnap.document), certificationChecked: false };
    setForm(normalized);
    saveDraft(normalized);
    setSaveMessage(`Loaded submission from ${latestSnap.submittedAt ? new Date(latestSnap.submittedAt).toISOString().slice(0, 7) : ''}`);
    setSubmitMessage('');
    setSubmitError('');
  };

  const loadSample = () => {
    const sampleDoc: DisclosureDocument = normalizeDocument({
      recordYear: new Date().getFullYear(),
      participant: {
        name: me?.user?.name ?? 'Sample Discloser',
        email: me?.user?.email ?? 'sample.discloser@example.org',
        hl7Roles: me?.user?.org_role ? [me.user.org_role] : ['Advisory Council'],
        consentPublic: true
      },
      roles: [
        {
          entityName: 'Nimbus Interop Cooperative',
          entityType: 'nonprofit',
          role: 'Program Advisor',
          paid: false,
          primaryEmployer: false,
          aboveThreshold: null
        },
        {
          entityName: 'Vanta Clinical Platforms',
          entityType: 'for_profit',
          role: 'Chief Standards Strategist',
          paid: true,
          primaryEmployer: true,
          aboveThreshold: null
        }
      ],
      financial: [
        {
          fundingSource: 'Beacon Health Analytics',
          entityType: 'for_profit',
          passThrough: true,
          intermediary: 'Lattice Consulting Group'
        },
        {
          fundingSource: 'Aurora Digital Trust',
          entityType: 'nonprofit',
          passThrough: false,
          intermediary: ''
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
    });
    setForm(sampleDoc);
    saveDraft(sampleDoc);
    setSaveMessage('Loaded sample disclosure');
    setSubmitMessage('');
    setSubmitError('');
  };

  const addRow = (key: 'roles' | 'financial' | 'ownerships' | 'gifts') => {
    setForm((f) => ({
      ...f,
      [key]: [
        ...f[key],
        key === 'roles'
          ? {
              entityName: '',
              entityType: 'for_profit',
              role: '',
              paid: false,
              primaryEmployer: false,
              aboveThreshold: null
            }
          : key === 'financial'
          ? {
              fundingSource: '',
              entityType: 'for_profit',
              passThrough: false,
              intermediary: ''
            }
          : key === 'ownerships'
          ? {
              entityName: '',
              entityType: 'public',
              tier: '1-5%'
            }
          : {
              sponsor: '',
              entityType: 'for_profit'
            }
      ]
    }));
  };

  const removeRow = (key: 'roles' | 'financial' | 'ownerships' | 'gifts', idx: number) => {
    setForm((f) => ({
      ...f,
      [key]: f[key].filter((_, i) => i !== idx)
    }));
  };

  const updateField = (path: (string | number)[], value: any) => {
    setForm((f) => {
      const copy: any = structuredClone(f);
      let ref = copy;
      for (let i = 0; i < path.length - 1; i++) {
        ref = ref[path[i]];
      }
      ref[path[path.length - 1]] = value;
      return copy;
    });
  };

  const canGoNext = useMemo(() => {
    if (step === 0) return form.participant.name && form.participant.consentPublic;
    return true;
  }, [step, form]);

  const summaryTotals = useMemo(() => ({
    roles: form.roles.length,
    financial: form.financial.length,
    ownerships: form.ownerships.length,
    gifts: form.gifts.length
  }), [form]);

  const summaryDescription = useMemo(() => {
    const parts = [
      `${summaryTotals.roles} role${summaryTotals.roles === 1 ? '' : 's'}`,
      `${summaryTotals.financial} funding source${summaryTotals.financial === 1 ? '' : 's'}`,
      `${summaryTotals.ownerships} ownership${summaryTotals.ownerships === 1 ? '' : 's'}`,
      `${summaryTotals.gifts} gift/travel item${summaryTotals.gifts === 1 ? '' : 's'}`
    ];
    return parts.join(' • ');
  }, [summaryTotals]);

  const formattedJson = useMemo(() => JSON.stringify(form, null, 2), [form]);

  const copyJson = useCallback(async () => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(formattedJson);
      setCopyNotice('JSON copied to clipboard');
    } catch {
      setCopyNotice('Unable to copy JSON');
    }
    copyTimeoutRef.current = window.setTimeout(() => setCopyNotice(''), 2000);
  }, [formattedJson]);

  const downloadJson = useCallback(() => {
    const blob = new Blob([formattedJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `disclosure-${timestamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setCopyNotice('JSON downloaded');
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => setCopyNotice(''), 2000);
  }, [formattedJson]);

  const submit = async () => {
    if (!form.participant.name || !form.participant.consentPublic || !form.certificationChecked) {
      setSubmitError('Complete the required fields before submitting.');
      return;
    }
    setSubmitMessage('');
    setSubmitError('');
    const res = await fetch('/api/disclosure/submit', { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      setSubmitError('Unable to submit disclosure. Please try again once you are logged in.');
      return;
    }
    const js = await res.json();
    setRecord(js.disclosure);
    setSubmitMessage('Disclosure submitted successfully.');
    refresh();
  };

  useEffect(() => () => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
  }, []);

  if (loading) {
    if (unauthenticated) {
      return (
        <div className="container">
          <div className="card">
            <h1>Disclosure Form</h1>
            <p className="small">Please log in to view or edit your disclosure.</p>
          </div>
        </div>
      );
    }
    return <div className="container"><div className="card">Loading...</div></div>;
  }

  if (unauthenticated) {
    return (
      <div className="container">
        <div className="card">
          <h1>Disclosure Form</h1>
          <p className="small">Please log in to view or edit your disclosure.</p>
          {me?.user && me.user.email && <p className="small">Current session: {me.user.email}</p>}
        </div>
      </div>
    );
  }

  const timeline = record?.history ?? [];
  const latestHistory = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-10 backdrop-blur bg-white/95 border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-slate-200 text-slate-900 font-bold tracking-tight">HL7</span>
            <div>
              <div className="text-sm text-slate-500">Conflict of Interest</div>
              <div className="text-base font-semibold text-slate-800">Public Register Aligned – Disclosure Form</div>
            </div>
          </div>
          <div className="flex items-center gap-2 topbar-actions">
            <button onClick={() => saveDraft()} className="text-sm px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Save draft</button>
            {record?.history?.length ? (
              <button onClick={loadLastSubmission} className="text-sm px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Load submission from {record.history[record.history.length - 1].submittedAt ? new Date(record.history[record.history.length - 1].submittedAt).toISOString().slice(0, 7) : ''}</button>
            ) : null}
            <button onClick={loadSample} className="text-sm px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Load sample</button>
            <button onClick={resetForm} className="text-sm px-3 py-2 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50">Reset</button>
          </div>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 pt-6 pb-24">
        <ol className="stepper">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}>
                <span className="badge">{i + 1}</span>
                <span>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>

        {latestHistory && (
          <details className="historySummary">
            <summary>Last submitted {formatDateTime(latestHistory.submittedAt)}</summary>
            <div className="historyList">
              {[...timeline].reverse().map((snap) => (
                <div key={snap.id} className="historyRow">
                  <span className="historyDate">{formatDateTime(snap.submittedAt)}</span>
                  <span className="historyCounts">{snap.document.roles.length} roles • {snap.document.financial.length} funding • {snap.document.ownerships.length} ownership • {snap.document.gifts.length} gifts</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {step === 0 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Community Disclosures</h2>
              <p className="text-sm text-slate-600 mt-1">Your name and HL7 roles will be published. Funding sources are disclosed by specific payer; pass-through intermediaries are shown along with the entity that pays you.</p>
            </header>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="name">Full name (public) *</label>
                <input id="name" value={form.participant.name} onChange={(e) => updateField(['participant', 'name'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="e.g., Dr. Jane Doe" />
                <p className="text-xs text-slate-500 mt-1">Displayed on the public register along with disclosures.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="email">Email (internal)</label>
                <input id="email" type="email" value={form.participant.email} onChange={(e) => updateField(['participant', 'email'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="name@org.org" />
                <p className="text-xs text-slate-500 mt-1">Used for confirmations and reminders. Not displayed publicly.</p>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="hl7roles">HL7 role(s) (public)</label>
                <select
                  id="hl7roles"
                  multiple
                  value={form.participant.hl7Roles}
                  onChange={(e) => updateField(['participant', 'hl7Roles'], Array.from(e.target.selectedOptions).map((opt) => opt.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  size={8}
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
                <p className="text-xs text-slate-500 mt-1">Hold Ctrl (Windows) or Command (Mac) to select multiple roles.</p>
              </div>
              <div className="md:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="rounded border-slate-300" checked={form.participant.consentPublic} onChange={(e) => updateField(['participant', 'consentPublic'], e.target.checked)} />
                  I understand and agree that my name and disclosures will be publicly posted.
                </label>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                <span className="inline-block text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">No $ values collected</span>
                <span className="mx-2">•</span>
                <span className="inline-block text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">By-source + pass-through</span>
                <span className="mx-2">•</span>
                <span className="inline-block text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">Ownership tiers only</span>
              </div>
              <button disabled={!canGoNext} onClick={() => setStep(1)} className={`px-4 py-2 rounded-lg text-white ${canGoNext ? 'bg-slate-900 hover:bg-slate-800' : 'bg-slate-300'}`}>Start disclosure</button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Category 1 — Professional Roles</h2>
              <p className="text-sm text-slate-600 mt-1">List your primary employer and any governance/advisory roles. Report roles only when compensation or fiduciary responsibilities meet the HL7 disclosure threshold (≥ $10k from that entity).</p>
            </header>
            <div className="space-y-4">
              {form.roles.map((role, idx) => (
                <div key={idx} className="roleCard">
                  <div className="grid md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700" htmlFor={`role-entity-${idx}`}>Entity name *</label>
                      <input id={`role-entity-${idx}`} value={role.entityName} onChange={(e) => updateField(['roles', idx, 'entityName'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Entity type</label>
                      <select value={role.entityType} onChange={(e) => updateField(['roles', idx, 'entityType'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                        <option value="for_profit">For-profit</option>
                        <option value="nonprofit">Nonprofit</option>
                        <option value="government">Government</option>
                        <option value="university">University</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Role/title *</label>
                      <input value={role.role} onChange={(e) => updateField(['roles', idx, 'role'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </div>
                  </div>
                  <div className="roleAttributes">
                    <div className="roleAttributesHeading">Role attributes</div>
                    <div className="roleAttributesOptions">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={role.primaryEmployer}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setForm((f) => {
                              const copy = structuredClone(f) as DisclosureDocument;
                              copy.roles[idx].primaryEmployer = checked;
                              if (checked) copy.roles[idx].paid = true;
                              return copy;
                            });
                          }}
                          className="rounded border-slate-300"
                        />
                        This is my primary employer
                      </label>
                      <label className={`inline-flex items-center gap-2 text-sm text-slate-700 ${role.primaryEmployer ? 'opacity-60' : ''}`}>
                        <input
                          type="checkbox"
                          checked={role.paid}
                          disabled={role.primaryEmployer}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            if (role.primaryEmployer) return;
                            setForm((f) => {
                              const copy = structuredClone(f) as DisclosureDocument;
                              copy.roles[idx].paid = checked;
                              return copy;
                            });
                          }}
                          className="rounded border-slate-300"
                        />
                        This is a paid role
                      </label>
                    </div>
                  </div>
                  <div className="removeRow">
                    <button
                      type="button"
                      className="removeLink"
                      onClick={() => {
                        if (window.confirm('Remove this role?')) removeRow('roles', idx);
                      }}
                    >
                      Remove role
                    </button>
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between">
                <button onClick={() => addRow('roles')} className="px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-sm">+ Add another role</button>
                <div className="flex gap-2">
                  <button onClick={() => setStep(0)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Back</button>
                  <button onClick={() => setStep(2)} className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Next</button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Category 1 (continued) — Funding by Source</h2>
              <p className="text-sm text-slate-600 mt-1">Report project/grant/contract, consulting, or speaking sources that met the HL7 threshold (≥ $10k per source in the prior 12 months). If paid via an intermediary, list the entity paying you as the intermediary.</p>
            </header>
            <div className="space-y-4">
              {form.financial.map((f, idx) => (
                <div key={idx} className="p-4 rounded-xl border border-slate-200 bg-slate-50">
                  <div className="grid md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Funding source *</label>
                      <input value={f.fundingSource} onChange={(e) => updateField(['financial', idx, 'fundingSource'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Entity type</label>
                      <select value={f.entityType} onChange={(e) => updateField(['financial', idx, 'entityType'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                        <option value="for_profit">For-profit</option>
                        <option value="nonprofit">Nonprofit</option>
                        <option value="government">Government</option>
                        <option value="university">University</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-3 gap-4 mt-3">
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Paid via intermediary?</label>
                      <label className="mt-2 inline-flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={f.passThrough} onChange={(e) => updateField(['financial', idx, 'passThrough'], e.target.checked)} className="rounded border-slate-300" /> Yes
                      </label>
                      {f.passThrough && (
                        <div className="mt-2">
                          <label className="block text-sm font-medium text-slate-700">Intermediary *</label>
                          <select
                            value={deriveIntermediarySelectValue(form.roles, f.intermediary)}
                            onChange={(e) => {
                              const val = e.target.value;
                              const isCurrentlyCustom = deriveIntermediarySelectValue(form.roles, f.intermediary) === '__custom';
                              if (val === '__custom') {
                                updateField(['financial', idx, 'intermediary'], isCurrentlyCustom ? (f.intermediary || '') : '');
                              } else {
                                updateField(['financial', idx, 'intermediary'], val);
                              }
                            }}
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                          >
                            <option value="">Select intermediary</option>
                            {form.roles.filter(r => r.entityName).map((r, i) => (
                              <option key={`${r.entityName}-${i}`} value={r.entityName}>{r.entityName}</option>
                            ))}
                            <option value="__custom">Other…</option>
                          </select>
                          {deriveIntermediarySelectValue(form.roles, f.intermediary) === '__custom' ? (
                            <textarea
                              value={f.intermediary}
                              onChange={(e) => updateField(['financial', idx, 'intermediary'], e.target.value)}
                              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
                              placeholder="Enter intermediary name"
                              rows={2}
                            />
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button onClick={() => removeRow('financial', idx)} className="text-sm text-rose-700 border border-rose-300 rounded-lg px-3 py-2 hover:bg-rose-50">Remove</button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button onClick={() => addRow('financial')} className="px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-sm">+ Add another source</button>
                <div className="flex gap-2">
                  <button onClick={() => setStep(1)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Back</button>
                  <button onClick={() => setStep(3)} className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Next</button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Category 2 — Ownership Interests (≥ 1%)</h2>
              <p className="text-sm text-slate-600 mt-1">Disclose entities where you own ≥ 1% (tiers only). No exact percentages or dollar values.</p>
            </header>
            <div className="space-y-4">
              {form.ownerships.map((o, idx) => (
                <div key={idx} className="p-4 rounded-xl border border-slate-200 bg-slate-50">
                  <div className="grid md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Entity name *</label>
                      <input value={o.entityName} onChange={(e) => updateField(['ownerships', idx, 'entityName'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Entity type</label>
                      <select value={o.entityType} onChange={(e) => updateField(['ownerships', idx, 'entityType'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                        <option value="public">Publicly traded</option>
                        <option value="private">Privately held</option>
                        <option value="llc">Partnership/LLC</option>
                        <option value="nonprofit">Nonprofit/Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Ownership tier *</label>
                      <select value={o.tier} onChange={(e) => updateField(['ownerships', idx, 'tier'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                        <option value="1-5%">1–5%</option>
                        <option value=">5%">&gt;5%</option>
                      </select>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button onClick={() => removeRow('ownerships', idx)} className="text-sm text-rose-700 border border-rose-300 rounded-lg px-3 py-2 hover:bg-rose-50">Remove</button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button onClick={() => addRow('ownerships')} className="px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-sm">+ Add ownership</button>
                <div className="flex gap-2">
                  <button onClick={() => setStep(2)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Back</button>
                  <button onClick={() => setStep(4)} className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Next</button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Category 3 — Sponsored Travel, Gifts & Hospitality</h2>
              <p className="text-sm text-slate-600 mt-1">Include sponsors whose hospitality exceeded $10k from a single source in a calendar year. One row per sponsor per period.</p>
            </header>
            <div className="space-y-4">
              {form.gifts.map((g, idx) => (
                <div key={idx} className="p-4 rounded-xl border border-slate-200 bg-slate-50">
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Sponsor *</label>
                      <input value={g.sponsor} onChange={(e) => updateField(['gifts', idx, 'sponsor'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700">Entity type</label>
                      <select value={g.entityType} onChange={(e) => updateField(['gifts', idx, 'entityType'], e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                        <option value="for_profit">For-profit</option>
                        <option value="nonprofit">Nonprofit</option>
                        <option value="government">Government</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button onClick={() => removeRow('gifts', idx)} className="text-sm text-rose-700 border border-rose-300 rounded-lg px-3 py-2 hover:bg-rose-50">Remove</button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button onClick={() => addRow('gifts')} className="px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-sm">+ Add sponsor</button>
                <div className="flex gap-2">
                  <button onClick={() => setStep(3)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Back</button>
                  <button onClick={() => setStep(5)} className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Next</button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-slate-800">Review & submit</h2>
              <p className="text-sm text-slate-600 mt-1">Confirm your entries. Submitting will generate the public-register rows by source.</p>
            </header>
            <p className="summaryInline">Summary: {summaryDescription}</p>

            <div className="reviewLayout">
              <div className="reviewDetails">
                <section className="detailSection">
                  <h3 className="detailHeading">Participant</h3>
                  <div className="detailBody">
                    <div><strong>Name:</strong> {form.participant.name || '—'}</div>
                    <div><strong>HL7 role(s):</strong> {form.participant.hl7Roles.join('; ') || '—'}</div>
                    <div className="detailNote">Public: name, HL7 roles • Not public: email</div>
                  </div>
                </section>
                <section className="detailSection">
                  <h3 className="detailHeading">Roles ({summaryTotals.roles})</h3>
                  {summaryTotals.roles === 0 ? (
                    <div className="emptyState">No roles recorded.</div>
                  ) : (
                    <ul className="reviewList">
                      {form.roles.map((role, idx) => (
                        <li key={idx}>{describeRole(role)}</li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="detailSection">
                  <h3 className="detailHeading">Funding sources ({summaryTotals.financial})</h3>
                  {summaryTotals.financial === 0 ? (
                    <div className="emptyState">No funding sources recorded.</div>
                  ) : (
                    <ul className="reviewList">
                      {form.financial.map((entry, idx) => (
                        <li key={idx}>{describeFinancial(entry)}</li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="detailSection">
                  <h3 className="detailHeading">Ownerships ({summaryTotals.ownerships})</h3>
                  {summaryTotals.ownerships === 0 ? (
                    <div className="emptyState">No ownership interests recorded.</div>
                  ) : (
                    <ul className="reviewList">
                      {form.ownerships.map((entry, idx) => (
                        <li key={idx}>{describeOwnership(entry)}</li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="detailSection">
                  <h3 className="detailHeading">Gifts / Travel ({summaryTotals.gifts})</h3>
                  {summaryTotals.gifts === 0 ? (
                    <div className="emptyState">No gifts or travel recorded.</div>
                  ) : (
                    <ul className="reviewList">
                      {form.gifts.map((entry, idx) => (
                        <li key={idx}>{describeGift(entry)}</li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <aside className="jsonPane">
                <div className="jsonHeader">
                  <h3 className="detailHeading">Register preview</h3>
                  <div className="jsonActions">
                    <button className="iconButton" onClick={copyJson} type="button" aria-label="Copy register JSON">
                      <span aria-hidden="true">📋</span>
                    </button>
                    <button className="iconButton" onClick={downloadJson} type="button" aria-label="Download register JSON">
                      <span aria-hidden="true">⬇</span>
                    </button>
                  </div>
                </div>
                <div className="jsonPreview">
                  <pre>{formattedJson}</pre>
                </div>
                {copyNotice && <div className="copyNotice">{copyNotice}</div>}
              </aside>
            </div>

            <div className="mt-6">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="rounded border-slate-300" checked={form.certificationChecked} onChange={(e) => updateField(['certificationChecked'], e.target.checked)} />
                I certify I have disclosed all known interests per HL7 thresholds and agree to public posting (no $ values).
              </label>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button onClick={() => setStep(4)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">Back</button>
              <button
                disabled={!form.participant.name || !form.participant.consentPublic || !form.certificationChecked}
                className={`px-5 py-2 rounded-lg text-white ${(!form.participant.name || !form.participant.consentPublic || !form.certificationChecked) ? 'bg-slate-300' : 'bg-emerald-600 hover:bg-emerald-500'}`}
                onClick={submit}
              >
                Submit disclosure
              </button>
            </div>
            {(submitMessage || submitError) && (
              <div className="mt-4">
                {submitMessage && <div className="successMessage">{submitMessage}</div>}
                {submitError && <div className="errorMessage">{submitError}</div>}
              </div>
            )}
          </section>
        )}

      </main>
    </div>
  );
}

const Pill = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-block text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">{children}</span>
);

function Nav() {
  const { refresh } = useMe();
  const meta = useMeta();

  const handleLogout = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    await fetch('/auth/logout', { credentials: 'include' });
    refresh();
  }, [refresh]);

  const handleLogin = useCallback((e: React.MouseEvent) => {
    if (meta?.mockAuth) {
      e.preventDefault();
      window.location.href = '/#mock-login';
    }
  }, [meta]);

  return (
    <header>
      <div className="container">
        <nav>
          <Link to="/">Home</Link>
          <Link to="/form">Disclosure Form</Link>
          <Link to="/admin">Admin</Link>
          <Link to="/public">Public</Link>
        </nav>
        <nav>
          <a href="/auth/login" onClick={handleLogin}>Login</a>
          <a href="/auth/logout" onClick={handleLogout}>Logout</a>
        </nav>
      </div>
    </header>
  );
}

function Home() {
  const { data: me } = useMe();
  const meta = useMeta();
  const mockLinks = useMemo(() => ([
    { label: 'Jane Doe – Board (admin)', query: 'email=jane.doe@example.org&name=Jane%20Doe&admin=true' },
    { label: 'John Smith – TSC', query: 'email=john.smith@example.org&name=John%20Smith' },
    { label: 'Ava Liu – Product Director', query: 'email=ava.liu@example.org&name=Ava%20Liu' },
    { label: 'Miguel Torres – Program Chair', query: 'email=miguel.torres@example.org&name=Miguel%20Torres' },
    { label: 'Sahana Gupta – Co-chair', query: 'email=sahana.gupta@example.org&name=Sahana%20Gupta' }
  ]), []);

  return (
    <div className="container">
      <div className="card">
        <h1>HL7 COI Disclosure Portal</h1>
        <p>Use your HL7 account to log in and complete your annual disclosure. Admins can generate a public report and static site.</p>
        <p className="small">Note: This portal collects relationships only—no dollar amounts or household details. NDA-restricted sponsors appear by sector and topic only.</p>
      </div>
      {me?.user && (
        <div className="card">
          <h2>Welcome, {me.user.name}</h2>
          <div className="small">Role: {me.user.org_role} · {me.user.is_admin ? 'Admin' : 'Discloser'}</div>
        </div>
      )}
      {meta?.mockAuth && (
        <div className="card" id="mock-login">
          <h2>Mock login shortcuts</h2>
          <p className="small">MOCK_AUTH is enabled. Use these links to impersonate seeded users:</p>
          <ul className="mockLoginList">
            {mockLinks.map((link) => (
              <li key={link.label}><a href={`/auth/login?${link.query}`}>{link.label}</a></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Admin() {
  const { refresh } = useMe();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch('/api/admin/disclosers', { credentials: 'include' }).then(async (r) => {
      if (r.status === 403) {
        setError('Admins only. Log in with an administrator account to view this dashboard.');
        setLoading(false);
        refresh();
        return;
      }
      const js = await r.json();
      setRows(js.disclosers);
      setLoading(false);
    });
  }, []);

  const generateReport = async () => {
    setMessage('');
    const res = await fetch('/api/admin/generate-public-report', { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      setMessage('Failed to generate report. Confirm you are logged in as an admin.');
      refresh();
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'public_disclosures.csv';
    a.click();
    URL.revokeObjectURL(url);
    setMessage('Report generated. Check your downloads for public_disclosures.csv.');
  };

  if (loading) return <div className="container"><div className="card">Loading...</div></div>;

  if (error) {
    return (
      <div className="container">
        <div className="card">
          <p className="small">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Administrator Dashboard</h1>
          <p className="sectionDescription" style={{ marginTop: '4px' }}>Manage disclosure status and publish the public-facing report.</p>
        </div>
        <button className="primary" onClick={generateReport}>Generate Public Report</button>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last Updated</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.user_id}>
                <td>{r.name}</td>
                <td>{r.email}</td>
                <td>{r.org_role}</td>
                <td>{r.status}</td>
                <td>{r.last_updated_ts ? formatDateTime(r.last_updated_ts) : '-'}</td>
                <td><Link to={`/admin/user/${r.user_id}`}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message && <div className="card"><p className="small">{message}</p></div>}
    </div>
  );
}

function describeRole(role: RoleDisclosure) {
  return `${role.entityName} — ${role.role}${role.primaryEmployer ? ' (primary employer)' : ''}`;
}

function describeFinancial(entry: FinancialDisclosure) {
  const via = entry.passThrough && entry.intermediary ? ` via ${entry.intermediary}` : '';
  return `${entry.fundingSource}${via}`;
}

function describeOwnership(entry: OwnershipDisclosure) {
  return `${entry.entityName} (${entry.tier})`;
}

function describeGift(entry: GiftDisclosure) {
  return entry.sponsor;
}

function DisclosureReadOnly({ document }: { document: DisclosureDocument }) {
  const counts = summarizeDocumentCounts(document);
  return (
    <div className="publicDocument">
      <p className="summaryInline">Summary: {formatSummaryText(counts)}</p>
      <section className="detailSection">
        <h3 className="detailHeading">Participant</h3>
        <div className="detailBody">
          <div><strong>Name:</strong> {document.participant.name || '—'}</div>
          <div><strong>HL7 role(s):</strong> {document.participant.hl7Roles.join('; ') || '—'}</div>
        </div>
      </section>
      <section className="detailSection">
        <h3 className="detailHeading">Roles ({document.roles.length})</h3>
        {document.roles.length === 0 ? (
          <div className="emptyState">No roles recorded.</div>
        ) : (
          <ul className="reviewList">
            {document.roles.map((role, idx) => (
              <li key={idx}>{describeRole(role)}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="detailSection">
        <h3 className="detailHeading">Funding sources ({document.financial.length})</h3>
        {document.financial.length === 0 ? (
          <div className="emptyState">No funding sources recorded.</div>
        ) : (
          <ul className="reviewList">
            {document.financial.map((entry, idx) => (
              <li key={idx}>{describeFinancial(entry)}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="detailSection">
        <h3 className="detailHeading">Ownerships ({document.ownerships.length})</h3>
        {document.ownerships.length === 0 ? (
          <div className="emptyState">No ownership interests recorded.</div>
        ) : (
          <ul className="reviewList">
            {document.ownerships.map((entry, idx) => (
              <li key={idx}>{describeOwnership(entry)}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="detailSection">
        <h3 className="detailHeading">Gifts / Travel ({document.gifts.length})</h3>
        {document.gifts.length === 0 ? (
          <div className="emptyState">No gifts or travel recorded.</div>
        ) : (
          <ul className="reviewList">
            {document.gifts.map((entry, idx) => (
              <li key={idx}>{describeGift(entry)}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AdminUser() {
  const { userId } = useParams();
  const { refresh } = useMe();
  const [record, setRecord] = useState<DisclosureRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/admin/disclosures/${userId}`, { credentials: 'include' }).then(async (r) => {
      if (!r.ok) {
        setError('Admins only. Log in with an administrator account to view this disclosure.');
        refresh();
        return;
      }
      const js = await r.json();
      setRecord(js.disclosure);
    }).catch(() => setError('Unable to load disclosure details.'));
  }, [userId]);

  if (error) return <div className="container"><div className="card"><p className="small">{error}</p></div></div>;
  if (!record) return <div className="container"><div className="card">Loading...</div></div>;

  const snapshots = [...record.history].reverse();
  const draftDoc = record.draft?.document;

  return (
    <div className="container">
      <div className="card">
        <h1>Disclosure Details</h1>
      </div>
      {snapshots.length === 0 ? (
        <div className="card">
          <h2>No submissions yet</h2>
          {draftDoc ? <AdminDocumentView document={draftDoc} /> : <p className="small">No draft saved.</p>}
        </div>
      ) : (
        snapshots.map((snap) => (
          <div className="card" key={snap.id}>
            <h2>Submitted {formatDateTime(snap.submittedAt)}</h2>
            <AdminDocumentView document={snap.document} />
          </div>
        ))
      )}
      {draftDoc && (
        <div className="card">
          <h2>Current draft (saved {formatDateTime(record.draft?.savedAt)})</h2>
          <AdminDocumentView document={draftDoc} />
        </div>
      )}
    </div>
  );
}

function AdminDocumentView({ document }: { document: DisclosureDocument }) {
  return (
    <div className="entryGroups">
      <div className="entryGroup">
        <div className="groupTitle">Participant</div>
        <ul>
          <li>{document.participant.name} ({document.participant.hl7Roles.join('; ')})</li>
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Roles ({document.roles.length})</div>
        <ul>
          {document.roles.length === 0 ? <li>None</li> : document.roles.map((role, i) => <li key={i}>{describeRole(role)}</li>)}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Financial sources ({document.financial.length})</div>
        <ul>
          {document.financial.length === 0 ? <li>None</li> : document.financial.map((entry, i) => <li key={i}>{describeFinancial(entry)}</li>)}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Ownership ({document.ownerships.length})</div>
        <ul>
          {document.ownerships.length === 0 ? <li>None</li> : document.ownerships.map((entry, i) => <li key={i}>{describeOwnership(entry)}</li>)}
        </ul>
      </div>
      <div className="entryGroup">
        <div className="groupTitle">Gifts / Travel ({document.gifts.length})</div>
        <ul>
          {document.gifts.length === 0 ? <li>None</li> : document.gifts.map((entry, i) => <li key={i}>{describeGift(entry)}</li>)}
        </ul>
      </div>
    </div>
  );
}

function PublicIndex() {
  const [profiles, setProfiles] = useState<PublicProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/public/disclosers').then(async (res) => {
      if (!res.ok) {
        setError('Unable to load public disclosures.');
        setLoading(false);
        return;
      }
      const data = await res.json() as { profiles: PublicProfileSummary[] };
      setProfiles(data.profiles);
      setLoading(false);
    }).catch(() => {
      setError('Unable to load public disclosures.');
      setLoading(false);
    });
  }, []);

  return (
    <div className="container">
      <div className="card">
        <h1>Community Disclosures</h1>
        <p className="small">Browse the latest submitted disclosures. Select a discloser to view full details.</p>
        {loading ? (
          <div className="small">Loading…</div>
        ) : error ? (
          <div className="errorMessage">{error}</div>
        ) : (
          <ul className="publicList">
            {profiles.map((profile) => (
              <li key={profile.hl7_id}>
                <Link to={`/public/${encodeURIComponent(profile.hl7_id)}`}>{profile.name}</Link>
                <div className="publicMeta">Role: {profile.org_role}</div>
                {profile.last_submitted_at ? (
                  <div className="publicCounts">Submitted {formatDateTime(profile.last_submitted_at)}</div>
                ) : (
                  <div className="publicCounts">No submissions yet</div>
                )}
                {profile.last_submitted_at && (
                  <div className="publicCounts">{formatSummaryText(profile.counts)}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PublicProfile() {
  const { sub } = useParams();
  const encodedSub = sub ? encodeURIComponent(sub) : '';
  const [detail, setDetail] = useState<PublicDisclosureDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sub) return;
    fetch(`/api/public/disclosures/${encodeURIComponent(sub)}`).then(async (res) => {
      if (!res.ok) {
        setError('No disclosures found for this person.');
        setLoading(false);
        return;
      }
      const data = await res.json() as PublicDisclosureDetail;
      setDetail(data);
      setLoading(false);
    }).catch(() => {
      setError('Unable to load disclosure.');
      setLoading(false);
    });
  }, [sub]);

  return (
    <div className="container">
      <div className="card">
        <Link to="/public" className="small">← Back to public directory</Link>
        {loading ? (
          <div className="small" style={{ marginTop: 12 }}>Loading…</div>
        ) : error || !detail ? (
          <div className="errorMessage" style={{ marginTop: 12 }}>{error || 'Not found.'}</div>
        ) : (
          <>
            <h1>{detail.user.name}</h1>
            <p className="small">Role: {detail.user.org_role}</p>
            {detail.latest ? (
              <>
                <h2 style={{ marginTop: 24 }}>Latest submission ({formatDateTime(detail.latest.submittedAt)})</h2>
                <DisclosureReadOnly document={detail.latest.document} />
              </>
            ) : (
              <div className="small" style={{ marginTop: 24 }}>No submissions yet.</div>
            )}
            <section className="detailSection" style={{ marginTop: 24 }}>
              <h3 className="detailHeading">Submission history</h3>
              {detail.history.length === 0 ? (
                <div className="small">None</div>
              ) : (
                <ul className="historyLinks">
                  {detail.history.slice().reverse().map((entry) => (
                    <li key={entry.id}>
                      <Link to={`/public/${encodedSub}/${encodeURIComponent(entry.submittedAt)}`}>{formatDateTime(entry.submittedAt)}</Link>
                      <span>{formatSummaryText(entry.counts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function PublicSnapshot() {
  const { sub, timestamp } = useParams();
  const [detail, setDetail] = useState<PublicSnapshotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sub || !timestamp) return;
    fetch(`/api/public/disclosures/${encodeURIComponent(sub)}/${encodeURIComponent(timestamp)}`).then(async (res) => {
      if (!res.ok) {
        setError('Submission not found.');
        setLoading(false);
        return;
      }
      const data = await res.json() as PublicSnapshotDetail;
      setDetail(data);
      setLoading(false);
    }).catch(() => {
      setError('Unable to load submission.');
      setLoading(false);
    });
  }, [sub, timestamp]);

  const encodedSub = sub ? encodeURIComponent(sub) : '';

  return (
    <div className="container">
      <div className="card">
        <Link to={`/public/${encodedSub}`} className="small">← Back to profile</Link>
        {loading ? (
          <div className="small" style={{ marginTop: 12 }}>Loading…</div>
        ) : error || !detail ? (
          <div className="errorMessage" style={{ marginTop: 12 }}>{error || 'Not found.'}</div>
        ) : (
          <>
            <h1>{detail.user.name}</h1>
            <p className="small">Submission from {formatDateTime(detail.submission.submittedAt)}</p>
            <DisclosureReadOnly document={detail.submission.document} />
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/form" element={<COIForm />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/user/:userId" element={<AdminUser />} />
        <Route path="/public" element={<PublicIndex />} />
        <Route path="/public/:sub" element={<PublicProfile />} />
        <Route path="/public/:sub/:timestamp" element={<PublicSnapshot />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
