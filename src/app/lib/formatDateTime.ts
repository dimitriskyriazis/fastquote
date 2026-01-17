const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
};

export function formatDateTime(value?: string | Date | null) {
  if (value == null) return "Unknown time";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-GB", DATE_TIME_FORMAT_OPTIONS);
}
