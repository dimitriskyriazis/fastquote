'use client';

export type PaymentTermFormValues = {
  name: string;
  descriptionGR: string;
  descriptionEN: string;
  enabled: boolean;
};

export const EMPTY_PAYMENT_TERM_FORM: PaymentTermFormValues = {
  name: '',
  descriptionGR: '',
  descriptionEN: '',
  enabled: true,
};

const normalizeTextValue = (value: string) => value.trim();

export const validatePaymentTermForm = (form: PaymentTermFormValues): string | null => {
  if (!normalizeTextValue(form.name)) return 'Payment term name is required.';
  if (!normalizeTextValue(form.descriptionGR)) return 'Greek description is required.';
  if (!normalizeTextValue(form.descriptionEN)) return 'English description is required.';
  return null;
};

export const buildPaymentTermPayload = (form: PaymentTermFormValues) => ({
  name: normalizeTextValue(form.name),
  descriptionGR: normalizeTextValue(form.descriptionGR),
  descriptionEN: normalizeTextValue(form.descriptionEN),
  enabled: Boolean(form.enabled),
});

export type PaymentTermCreationResult = {
  ok: boolean;
  paymentTerm?: {
    PaymentTermID: number;
    Name: string | null;
    DescriptionGR: string | null;
    DescriptionEN: string | null;
    CustomerCount: number | null;
    Enabled: boolean | number | null;
  };
  error?: string;
};

const PAYMENT_TERM_CREATION_ENDPOINT = '/api/payment-terms/create';

export const createPaymentTerm = async (
  form: PaymentTermFormValues,
): Promise<PaymentTermCreationResult> => {
  try {
    const response = await fetch(PAYMENT_TERM_CREATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPaymentTermPayload(form)),
    });
    const payload = (await response.json().catch(() => null)) as PaymentTermCreationResult | null;
    if (!response.ok || !payload?.ok) {
      // Pass the server text straight through: the create route answers a
      // UQ_PaymentTerms_Name collision with a written 409 message.
      return {
        ok: false,
        error: payload?.error ?? 'Unable to add payment term.',
      };
    }
    return { ok: true, paymentTerm: payload.paymentTerm };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to add payment term.',
    };
  }
};
