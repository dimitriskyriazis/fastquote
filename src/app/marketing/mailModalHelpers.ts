'use client';

export type MailFormValues = {
  date: string;
  description: string;
  note: string;
};

export const EMPTY_MAIL_FORM: MailFormValues = {
  date: new Date().toISOString().split('T')[0],
  description: "",
  note: "",
};

const normalizeTextValue = (value: string) => value.trim();

export const validateMailForm = (form: MailFormValues): string | null => {
  if (!normalizeTextValue(form.description)) {
    return "Description is required.";
  }
  return null;
};

export const buildMailPayload = (form: MailFormValues) => ({
  date: form.date || new Date().toISOString().split('T')[0],
  description: normalizeTextValue(form.description),
  note: normalizeTextValue(form.note),
});

export type MailCreationResult = {
  ok: boolean;
  mailId?: number;
  error?: string;
};

const MAIL_CREATION_ENDPOINT = "/api/marketing/mails/create";

export const createMail = async (
  form: MailFormValues,
): Promise<MailCreationResult> => {
  try {
    const response = await fetch(MAIL_CREATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildMailPayload(form)),
    });
    const payload = (await response.json().catch(() => null)) as MailCreationResult | null;
    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        error: payload?.error ?? "Unable to create mail.",
      };
    }
    return { ok: true, mailId: payload.mailId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unable to create mail.",
    };
  }
};
