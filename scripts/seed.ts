import { DB } from '../src/db';
import type { DisclosureDocument } from '../src/disclosure_types';

const db = new DB();
db.init();

db.db.exec(`
  DELETE FROM disclosures;
  DELETE FROM sessions;
  DELETE FROM users;
`);

function minutesAgo(min: number) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

type SampleSubmission = {
  document: DisclosureDocument;
  submitted: boolean;
  offsetMinutes?: number;
};

type SampleUser = {
  hl7_id: string;
  name: string;
  email: string;
  org_role: string;
  is_admin?: boolean;
  submissions: SampleSubmission[];
};

const makeDocument = (overrides: Partial<DisclosureDocument>): DisclosureDocument => ({
  recordYear: new Date().getFullYear(),
  participant: {
    name: '',
    email: '',
    hl7Roles: [],
    consentPublic: false,
    ...overrides.participant
  },
  roles: (overrides.roles ?? []).map((role) => ({
    aboveThreshold: role.aboveThreshold ?? null,
    ...role
  })),
  financial: overrides.financial ?? [],
  ownerships: overrides.ownerships ?? [],
  gifts: overrides.gifts ?? [],
  certificationChecked: overrides.certificationChecked ?? false
});

const samples: SampleUser[] = [
  {
    hl7_id: 'hl7|1',
    name: 'Jane Doe',
    email: 'jane.doe@example.org',
    org_role: 'Board',
    is_admin: true,
    submissions: [
      {
        submitted: true,
        offsetMinutes: 60 * 24 * 21,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'Jane Doe',
            email: 'jane.doe@example.org',
            hl7Roles: ['Board Chair', 'FHIR Infrastructure WG'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'HL7 International',
              entityType: 'nonprofit',
              role: 'Board Chair',
              paid: false,
              primaryEmployer: false,
            },
            {
              entityName: 'FHIRWorks Solutions',
              entityType: 'for_profit',
              role: 'Chief Clinical Officer',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'ACME Pharma',
              entityType: 'for_profit',
              passThrough: true,
              intermediary: 'Clinical Insights Cooperative'
            },
            {
              fundingSource: 'Bright Health Analytics',
              entityType: 'for_profit',
              passThrough: true,
              intermediary: 'Clinical Insights Cooperative'
            }
          ],
          ownerships: [
            {
              entityName: 'FHIRWorks Solutions',
              entityType: 'private',
              tier: '1-5%'
            }
          ],
          gifts: [
            {
              sponsor: 'World Health Collaborative',
              entityType: 'nonprofit'
            }
          ],
          certificationChecked: true
        })
      },
      {
        submitted: false,
        offsetMinutes: 120,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'Jane Doe',
            email: 'jane.doe@example.org',
            hl7Roles: ['Board Chair', 'FHIR Infrastructure WG'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'HL7 International',
              entityType: 'nonprofit',
              role: 'Board Chair',
              paid: false,
              primaryEmployer: false,
            },
            {
              entityName: 'FHIRWorks Solutions',
              entityType: 'for_profit',
              role: 'Chief Clinical Officer',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'ACME Pharma',
              entityType: 'for_profit',
              passThrough: true,
              intermediary: 'Clinical Insights Cooperative'
            },
            {
              fundingSource: 'MedX Informatics',
              entityType: 'for_profit',
              passThrough: false,
              intermediary: ''
            }
          ],
          ownerships: [
            {
              entityName: 'FHIRWorks Solutions',
              entityType: 'private',
              tier: '1-5%'
            }
          ],
          gifts: [
            {
              sponsor: 'World Health Collaborative',
              entityType: 'nonprofit'
            }
          ],
          certificationChecked: false
        })
      }
    ]
  },
  {
    hl7_id: 'hl7|2',
    name: 'John Smith',
    email: 'john.smith@example.org',
    org_role: 'TSC',
    submissions: [
      {
        submitted: true,
        offsetMinutes: 60 * 24 * 45,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'John Smith',
            email: 'john.smith@example.org',
            hl7Roles: ['TSC Member'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'CommonCare Hospital',
              entityType: 'nonprofit',
              role: 'Director of Informatics',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'National Telehealth Network',
              entityType: 'nonprofit',
              passThrough: false,
              intermediary: ''
            }
          ],
          ownerships: [],
          gifts: [],
          certificationChecked: true
        })
      },
      {
        submitted: true,
        offsetMinutes: 60 * 24 * 10,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'John Smith',
            email: 'john.smith@example.org',
            hl7Roles: ['TSC Member'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'CommonCare Hospital',
              entityType: 'nonprofit',
              role: 'Director of Informatics',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'National Telehealth Network',
              entityType: 'nonprofit',
              passThrough: false,
              intermediary: ''
            },
            {
              fundingSource: 'Blue Horizon Payers Collaborative',
              entityType: 'for_profit',
              passThrough: false,
              intermediary: ''
            }
          ],
          ownerships: [],
          gifts: [],
          certificationChecked: true
        })
      }
    ]
  },
  {
    hl7_id: 'hl7|3',
    name: 'Ava Liu',
    email: 'ava.liu@example.org',
    org_role: 'ProductDirector',
    submissions: [
      {
        submitted: true,
        offsetMinutes: 60 * 24 * 30,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'Ava Liu',
            email: 'ava.liu@example.org',
            hl7Roles: ['Product Director'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'Interlace Health',
              entityType: 'for_profit',
              role: 'VP Product',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'WellSpan Health Innovation Lab',
              entityType: 'nonprofit',
              passThrough: false,
              intermediary: ''
            }
          ],
          ownerships: [
            {
              entityName: 'Interlace Health Stock Options',
              entityType: 'private',
              tier: '1-5%'
            }
          ],
          gifts: [
            {
              sponsor: 'Global Standards Forum',
              entityType: 'nonprofit'
            }
          ],
          certificationChecked: true
        })
      }
    ]
  },
  {
    hl7_id: 'hl7|4',
    name: 'Miguel Torres',
    email: 'miguel.torres@example.org',
    org_role: 'ProgramChair',
    submissions: [
      {
        submitted: true,
        offsetMinutes: 60 * 24 * 14,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'Miguel Torres',
            email: 'miguel.torres@example.org',
            hl7Roles: ['Program Chair'],
            consentPublic: true
          },
          roles: [
            {
              entityName: 'Public Health Ontario',
              entityType: 'government',
              role: 'Immunization Program Lead',
              paid: true,
              primaryEmployer: true,
            }
          ],
          financial: [
            {
              fundingSource: 'WHO Digital Health',
              entityType: 'government',
              passThrough: false,
              intermediary: ''
            },
            {
              fundingSource: 'CDC Foundation',
              entityType: 'nonprofit',
              passThrough: false,
              intermediary: ''
            }
          ],
          ownerships: [],
          gifts: [],
          certificationChecked: true
        })
      }
    ]
  },
  {
    hl7_id: 'hl7|5',
    name: 'Sahana Gupta',
    email: 'sahana.gupta@example.org',
    org_role: 'CoChair',
    submissions: [
      {
        submitted: false,
        document: makeDocument({
          recordYear: 2025,
          participant: {
            name: 'Sahana Gupta',
            email: 'sahana.gupta@example.org',
            hl7Roles: ['Co-chair'],
            consentPublic: false
          },
          roles: [],
          financial: [],
          ownerships: [],
          gifts: [],
          certificationChecked: false
        })
      }
    ]
  }
];

const summary: string[] = [];

for (const sample of samples) {
  const user = db.createOrUpdateUser({
    hl7_id: sample.hl7_id,
    name: sample.name,
    email: sample.email,
    org_role: sample.org_role
  });
  if (sample.is_admin) db.setAdminByEmail(sample.email);

  const disclosure = db.getOrCreateDisclosureForUser(user.id);

  for (const submission of sample.submissions) {
    const savedAt = submission.offsetMinutes ? minutesAgo(submission.offsetMinutes) : new Date().toISOString();
    db.saveDraft(disclosure.id, submission.document, savedAt);
    if (submission.submitted) {
      db.submitDraft(disclosure.id, savedAt);
    }
  }

  summary.push(`${sample.name} (${sample.email})`);
}

console.log('Seeded users:', summary.length);
for (const line of summary) {
  console.log(' -', line);
}
