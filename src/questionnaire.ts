import type { FHIRResource } from './db';

export const FI_CANONICAL_URL = 'https://rfi.hl7.org/Questionnaire/annual-submission';
export const FI_VERSION = '2025.10.0';

export const canonicalQuestionnaire: FHIRResource = {
  resourceType: 'Questionnaire',
  status: 'active',
  experimental: false,
  name: 'HL7FinancialInterestsRegister',
  title: 'Register of Financial Interests',
  url: FI_CANONICAL_URL,
  version: FI_VERSION,
  subjectType: ['Practitioner'],
  description: `Annual registration of roles, funding, ownership, and gifts in alignment with HL7 financial interest policies. This streamlined form captures the relationships necessary to maintain the public Register of Financial Interests.`,
  item: [
    {
      linkId: 'participant',
      text: 'Participant information',
      type: 'group',
      required: true,
      item: [
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
          text: 'I certify these financial interests meet HL7 thresholds and consent to public posting.',
          type: 'boolean',
          required: true
        }
      ]
    }
  ]
};
