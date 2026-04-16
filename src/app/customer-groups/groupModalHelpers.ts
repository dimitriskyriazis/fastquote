'use client';

export type GroupFormValues = {
  name: string;
  code: string;
  enabled: boolean;
};

export const EMPTY_GROUP_FORM: GroupFormValues = {
  name: "",
  code: "",
  enabled: true,
};

const normalizeTextValue = (value: string) => value.trim();

export const validateGroupForm = (form: GroupFormValues): string | null => {
  if (!normalizeTextValue(form.name)) {
    return "Group name is required.";
  }
  if (form.enabled === undefined || form.enabled === null) {
    return "Enabled is required.";
  }
  return null;
};

export const buildGroupPayload = (form: GroupFormValues) => ({
  name: normalizeTextValue(form.name),
  code: normalizeTextValue(form.code) || null,
  enabled: Boolean(form.enabled),
});

export type GroupCreationResult = {
  ok: boolean;
  group?: {
    CustomerGroupID: number;
    Name: string | null;
    Code: string | null;
    Enabled: boolean | number | null;
  };
  error?: string;
};

const GROUP_CREATION_ENDPOINT = "/api/customer-groups/create";

export const createGroup = async (form: GroupFormValues): Promise<GroupCreationResult> => {
  try {
    const response = await fetch(GROUP_CREATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGroupPayload(form)),
    });
    const payload = (await response.json().catch(() => null)) as GroupCreationResult | null;
    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        error: payload?.error ?? "Unable to add group.",
      };
    }
    return { ok: true, group: payload.group };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unable to add group.",
    };
  }
};
