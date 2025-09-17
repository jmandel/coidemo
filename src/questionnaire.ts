import type { FHIRResource } from './db';

export const COI_CANONICAL_URL = 'https://example.org/hl7-coi/Questionnaire/coi';
export const COI_VERSION = '2025.09.0';

export const canonicalQuestionnaire: FHIRResource = {
  resourceType: 'Questionnaire',
  status: 'active',
  experimental: false,
  name: 'HL7COIDisclosure',
  title: 'HL7 Conflict of Interest Disclosure',
  url: COI_CANONICAL_URL,
  version: COI_VERSION,
  subjectType: ['Practitioner'],
  description: `Annual disclosure of roles, funding, ownership, and gifts in accordance with HL7 policies. This simplified form captures the relationships necessary to generate the public COI register.`,
  item: [
    {
      linkId: 'participant',
      text: 'Participant information',
      type: 'group',
      required: true,
      item: [
        {
          linkId: 'participant.name',
          text: 'Full name (public)',
          type: 'string',
          required: true
        },
        {
          linkId: 'participant.email',
          text: 'Email (internal)',
          type: 'string'
        },
        {
          linkId: 'participant.hl7Roles',
          text: 'HL7 role(s) (public)',
          type: 'choice',
          repeats: true,
          answerOption: [
            { valueCoding: { code: 'Board', display: 'Board' } },
            { valueCoding: { code: 'Officer', display: 'Officer' } },
            { valueCoding: { code: 'Executive Committee', display: 'Executive Committee' } },
            { valueCoding: { code: 'TSC', display: 'TSC' } },
            { valueCoding: { code: 'Product Director', display: 'Product Director' } },
            { valueCoding: { code: 'Accelerator Director', display: 'Accelerator Director' } },
            { valueCoding: { code: 'Co-Chair', display: 'Co-Chair' } },
            { valueCoding: { code: 'Other', display: 'Other' } }
          ]
        },
        {
          linkId: 'participant.consentPublic',
          text: 'I consent to public posting of my name and disclosures',
          type: 'boolean',
          required: true
        }
      ]
    },
    {
      linkId: 'roles',
      text: 'Professional Roles',
      type: 'group',
      repeats: true,
      item: [
        {
          linkId: 'roles.entityName',
          text: 'Entity name',
          type: 'string',
          required: true
        },
        {
          linkId: 'roles.entityType',
          text: 'Entity type',
          type: 'choice',
          answerOption: [
            { valueCoding: { code: 'for_profit', display: 'For-profit' } },
            { valueCoding: { code: 'nonprofit', display: 'Nonprofit' } },
            { valueCoding: { code: 'government', display: 'Government' } },
            { valueCoding: { code: 'university', display: 'University' } },
            { valueCoding: { code: 'other', display: 'Other' } }
          ]
        },
        {
          linkId: 'roles.role',
          text: 'Role / Title',
          type: 'string',
          required: true
        },
        {
          linkId: 'roles.primaryEmployer',
          text: 'This is my primary employer',
          type: 'boolean'
        },
        {
          linkId: 'roles.paid',
          text: 'This role is paid',
          type: 'boolean'
        },
        {
          linkId: 'roles.aboveThreshold',
          text: 'Compensation meets HL7 disclosure threshold (≥ $10k)',
          type: 'choice',
          answerOption: [
            { valueCoding: { code: 'true', display: 'Yes' } },
            { valueCoding: { code: 'false', display: 'No' } },
            { valueCoding: { code: 'unknown', display: 'Not sure' } }
          ]
        }
      ]
    },
    {
      linkId: 'financial',
      text: 'Funding by Source',
      type: 'group',
      repeats: true,
      item: [
        {
          linkId: 'financial.fundingSource',
          text: 'Funding source',
          type: 'string',
          required: true
        },
        {
          linkId: 'financial.entityType',
          text: 'Entity type',
          type: 'choice',
          answerOption: [
            { valueCoding: { code: 'for_profit', display: 'For-profit' } },
            { valueCoding: { code: 'nonprofit', display: 'Nonprofit' } },
            { valueCoding: { code: 'government', display: 'Government' } },
            { valueCoding: { code: 'university', display: 'University' } },
            { valueCoding: { code: 'other', display: 'Other' } }
          ]
        },
        {
          linkId: 'financial.passThrough',
          text: 'Paid via intermediary?',
          type: 'boolean'
        },
        {
          linkId: 'financial.intermediary',
          text: 'Intermediary name',
          type: 'string'
        }
      ]
    },
    {
      linkId: 'ownerships',
      text: 'Ownership interests (≥ 1%)',
      type: 'group',
      repeats: true,
      item: [
        {
          linkId: 'ownerships.entityName',
          text: 'Entity name',
          type: 'string',
          required: true
        },
        {
          linkId: 'ownerships.entityType',
          text: 'Entity type',
          type: 'choice',
          answerOption: [
            { valueCoding: { code: 'public', display: 'Publicly traded' } },
            { valueCoding: { code: 'private', display: 'Privately held' } },
            { valueCoding: { code: 'llc', display: 'Partnership / LLC' } },
            { valueCoding: { code: 'nonprofit', display: 'Nonprofit or other' } }
          ]
        },
        {
          linkId: 'ownerships.tier',
          text: 'Ownership tier',
          type: 'choice',
          required: true,
          answerOption: [
            { valueCoding: { code: '1-5%', display: '1–5%' } },
            { valueCoding: { code: '>5%', display: '>5%' } }
          ]
        }
      ]
    },
    {
      linkId: 'gifts',
      text: 'Sponsored Travel, Gifts & Hospitality',
      type: 'group',
      repeats: true,
      item: [
        {
          linkId: 'gifts.sponsor',
          text: 'Sponsor',
          type: 'string',
          required: true
        },
        {
          linkId: 'gifts.entityType',
          text: 'Entity type',
          type: 'choice',
          answerOption: [
            { valueCoding: { code: 'for_profit', display: 'For-profit' } },
            { valueCoding: { code: 'nonprofit', display: 'Nonprofit' } },
            { valueCoding: { code: 'government', display: 'Government' } },
            { valueCoding: { code: 'other', display: 'Other' } }
          ]
        }
      ]
    },
    {
      linkId: 'certification',
      text: 'Certification',
      type: 'group',
      required: true,
      item: [
        {
          linkId: 'certification.statement',
          text: 'I certify I have disclosed all interests per HL7 thresholds and agree to public posting (no dollar amounts).',
          type: 'boolean',
          required: true
        }
      ]
    }
  ]
};
