'use client';

export type ContactFormValues = {
  customerId: string;
  titleId: string;
  lastName: string;
  firstName: string;
  position: string;
  email: string;
  emailStatus: string;
  secondEmail: string;
  secondEmailStatus: string;
  phone: string;
  mobile: string;
  importance: string;
  enabled: boolean;
};

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  customerId: "",
  titleId: "",
  lastName: "",
  firstName: "",
  position: "",
  email: "",
  emailStatus: "",
  secondEmail: "",
  secondEmailStatus: "",
  phone: "",
  mobile: "",
  importance: "",
  enabled: true,
};

const normalizeDropdownValue = (value: string) => value.trim();
const normalizeTextValue = (value: string) => value.trim();

export const validateContactForm = (form: ContactFormValues): string | null => {
  if (!normalizeDropdownValue(form.customerId)) {
    return "Customer is required.";
  }
  if (!normalizeDropdownValue(form.titleId)) {
    return "Title is required.";
  }
  if (!normalizeTextValue(form.lastName)) {
    return "Last name is required.";
  }
  if (!normalizeTextValue(form.firstName)) {
    return "First name is required.";
  }
  if (!normalizeTextValue(form.position)) {
    return "Position is required.";
  }
  if (!normalizeDropdownValue(form.importance)) {
    return "Importance is required.";
  }
  if (form.enabled === undefined || form.enabled === null) {
    return "Enabled is required.";
  }
  return null;
};

export const buildContactPayload = (form: ContactFormValues) => ({
  customerId: normalizeDropdownValue(form.customerId),
  titleId: normalizeDropdownValue(form.titleId),
  lastName: normalizeTextValue(form.lastName),
  firstName: normalizeTextValue(form.firstName),
  position: normalizeTextValue(form.position),
  email: normalizeTextValue(form.email),
  emailStatus: normalizeTextValue(form.emailStatus),
  secondEmail: normalizeTextValue(form.secondEmail),
  secondEmailStatus: normalizeTextValue(form.secondEmailStatus),
  phone: normalizeTextValue(form.phone),
  mobile: normalizeTextValue(form.mobile),
  importance: normalizeDropdownValue(form.importance),
  enabled: Boolean(form.enabled),
});

export type ContactCreationResult = {
  ok: boolean;
  contactId?: number;
  error?: string;
};

const CONTACT_CREATION_ENDPOINT = "/api/customer-contacts/create";

export const createContact = async (
  form: ContactFormValues,
): Promise<ContactCreationResult> => {
  try {
    const response = await fetch(CONTACT_CREATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildContactPayload(form)),
    });
    const payload = (await response.json().catch(() => null)) as ContactCreationResult | null;
    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        error: payload?.error ?? "Unable to add contact.",
      };
    }
    return { ok: true, contactId: payload.contactId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unable to add contact.",
    };
  }
};
