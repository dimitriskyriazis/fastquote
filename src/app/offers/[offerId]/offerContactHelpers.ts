'use client';

import type { OfferContactInfo } from './OfferBasicDataTypes';

export type ContactFormValues = {
  firstName: string;
  lastName: string;
  titleId: string;
  position: string;
  importance: string;
  enabled: boolean;
  phone: string;
  mobile: string;
  email: string;
  emailStatusId: string;
  secondEmail: string;
  secondEmailStatusId: string;
  notes: string;
};

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  firstName: '',
  lastName: '',
  titleId: '',
  position: '',
  importance: '',
  enabled: true,
  phone: '',
  mobile: '',
  email: '',
  emailStatusId: '',
  secondEmail: '',
  secondEmailStatusId: '',
  notes: '',
};

const CONTACT_ENDPOINT = (offerId: string) => `/api/offers/${encodeURIComponent(offerId)}/contacts`;

export const normalizeNumberInput = (value: string | number | null | undefined): number | null => {
  const trimmed = (value ?? '').toString().trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
};

export const validateContactForm = (form: ContactFormValues): string | null => {
  const trimmedFirst = (form.firstName ?? '').trim();
  const trimmedLast = (form.lastName ?? '').trim();
  if (!trimmedFirst && !trimmedLast) {
    return 'Please enter at least a first or last name.';
  }
  return null;
};

export type OfferContactCreationResult = {
  ok: boolean;
  contact?: OfferContactInfo;
  error?: string;
};

export const buildContactPayload = (form: ContactFormValues) => ({
  firstName: (form.firstName ?? '').trim(),
  lastName: (form.lastName ?? '').trim(),
  titleId: normalizeNumberInput(form.titleId),
  position: (form.position ?? '').trim(),
  importance: normalizeNumberInput(form.importance),
  enabled: form.enabled,
  phone: (form.phone ?? '').trim(),
  mobile: (form.mobile ?? '').trim(),
  email: (form.email ?? '').trim(),
  emailStatusId: normalizeNumberInput(form.emailStatusId),
  secondEmail: (form.secondEmail ?? '').trim(),
  secondEmailStatusId: normalizeNumberInput(form.secondEmailStatusId),
  notes: (form.notes ?? '').trim(),
});

export async function createOfferContact(
  offerId: string,
  form: ContactFormValues,
): Promise<OfferContactCreationResult> {
  const validationError = validateContactForm(form);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    const response = await fetch(CONTACT_ENDPOINT(offerId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildContactPayload(form)),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      contact?: OfferContactInfo;
    } | null;
    const success = response.ok && !!result?.ok && !!result.contact;
    return {
      ok: success,
      contact: result?.contact,
      error: success ? undefined : result?.error ?? 'Unable to add contact',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to add contact',
    };
  }
}
