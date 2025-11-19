export type LookupValue = number | string;

export type RawDropdownRow = {
  ID?: LookupValue | null;
  Name?: string | null;
};

export type DropdownOption = {
  value: string;
  label: string;
};

const normalizeLabel = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const toDropdownOptions = <TRow extends RawDropdownRow>(
  rows: TRow[] | null | undefined,
  fallbackPrefix = 'Option',
): DropdownOption[] =>
  (rows ?? [])
    .filter((row): row is TRow & { ID: LookupValue } => row?.ID != null)
    .map((row) => {
      const stringId = typeof row.ID === 'string' ? row.ID : String(row.ID);
      const label = normalizeLabel(row.Name);
      return {
        value: stringId,
        label: label ?? `${fallbackPrefix} ${stringId}`,
      };
    });
