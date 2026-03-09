'use client';

export type ContactGroupFormValues = {
  description: string;
  note: string;
  enabled: boolean;
};

export const EMPTY_CONTACT_GROUP_FORM: ContactGroupFormValues = {
  description: "",
  note: "",
  enabled: true,
};

export const validateContactGroupForm = (form: ContactGroupFormValues): string | null => {
  if (!form.description.trim()) {
    return "Description is required.";
  }
  return null;
};

export type ContactGroupCreationResult = {
  ok: boolean;
  contactGroupId?: number;
  error?: string;
};

export const createContactGroup = async (
  form: ContactGroupFormValues,
): Promise<ContactGroupCreationResult> => {
  try {
    const response = await fetch("/api/marketing/contact-groups/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: form.description.trim(),
        note: form.note.trim(),
        enabled: form.enabled,
      }),
    });
    const payload = (await response.json().catch(() => null)) as ContactGroupCreationResult | null;
    if (!response.ok || !payload?.ok) {
      return { ok: false, error: payload?.error ?? "Unable to create contact group." };
    }
    return { ok: true, contactGroupId: payload.contactGroupId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unable to create contact group." };
  }
};
