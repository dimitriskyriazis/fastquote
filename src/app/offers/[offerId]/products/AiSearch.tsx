'use client';

import React from 'react';
import styles from './AiSearch.module.css';

export type AiSearchSummary = {
  chips: Array<{ field: string; value: string }>;
  expansionCount: number;
};

// Column-id → human-readable label mapping used when constructing summary
// chips from a visible filter model.  Exported so both modals compute the
// same display names.
export const AI_SEARCH_COLUMN_LABELS: Record<string, string> = {
  BrandName: 'Brand',
  PartNumber: 'Part',
  ModelNumber: 'Model',
  Description: 'Description',
};

export function buildAiSearchSummary(params: {
  visibleModel: Record<string, { filter?: string } | unknown>;
  hiddenTokens: Record<string, Array<{ filter: string; weight?: number }>> | null;
}): AiSearchSummary {
  const chips = Object.entries(params.visibleModel)
    .map(([colId, cond]) => ({
      field: AI_SEARCH_COLUMN_LABELS[colId] ?? colId,
      value: ((cond as { filter?: string })?.filter ?? '').toString(),
    }))
    .filter((c) => c.value.length > 0);
  const expansionCount = params.hiddenTokens
    ? Object.values(params.hiddenTokens).reduce((n, arr) => n + arr.length, 0)
    : 0;
  return { chips, expansionCount };
}

type PillProps = {
  promptText: string;
  onPromptTextChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  submitted: boolean;
  busy: boolean;
  disabled?: boolean;
};

// Inline rounded pill containing the Search (AI) label, editable input,
// and a submit (→) / clear (✕) button.  Read-only + blue active-state
// styling while `submitted` is true.
export function AiSearchPromptPill({
  promptText,
  onPromptTextChange,
  onSubmit,
  onClear,
  submitted,
  busy,
  disabled,
}: PillProps) {
  const submitDisabled = disabled || busy || promptText.trim().length === 0;
  return (
    <label className={`${styles.promptLabel} ${submitted ? styles.promptLabelActive : ''}`}>
      <span className={styles.promptLabelText}>Search (AI):</span>
      <input
        type="text"
        className={styles.promptInput}
        value={promptText}
        placeholder="Barco Lens"
        onChange={(e) => onPromptTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (submitted) onClear();
            else onSubmit();
          }
        }}
        readOnly={submitted}
        disabled={disabled}
        data-fastquote-keep-selection="true"
      />
      {busy ? (
        <span className={styles.promptSpinner} aria-label="Expanding with AI" />
      ) : submitted ? (
        <button
          type="button"
          className={styles.promptActionButton}
          onClick={onClear}
          disabled={disabled}
          aria-label="Clear AI search"
          title="Clear AI search"
        >
          ✕
        </button>
      ) : (
        <button
          type="button"
          className={styles.promptActionButton}
          onClick={onSubmit}
          disabled={submitDisabled}
          aria-label="Run AI search"
          title="Run AI search"
        >
          →
        </button>
      )}
    </label>
  );
}

type BannerProps = {
  summary: AiSearchSummary;
  onClear: () => void;
};

// Horizontal summary band rendered in the space the AG Grid filter row
// normally occupies while an AI search is driving the grid.  Shows the
// AI's routing chips + expansion/semantic counts and an inline ✕ that
// exits AI search mode.
export function AiSearchBanner({ summary, onClear }: BannerProps) {
  return (
    <div className={styles.banner}>
      <span className={styles.bannerLabel}>AI Search</span>
      {summary.chips.map((chip, i) => (
        <span key={`${chip.field}-${i}`} className={styles.bannerChip}>
          <span className={styles.bannerChipField}>{chip.field}:</span>
          <span>{chip.value}</span>
        </span>
      ))}
      <span className={styles.bannerMeta}>
        {summary.expansionCount > 0 && `${summary.expansionCount} related terms`}
      </span>
      <button
        type="button"
        className={styles.bannerClear}
        onClick={onClear}
        aria-label="Clear AI search"
        title="Clear AI search"
      >
        ✕
      </button>
    </div>
  );
}

// Re-export the lock class so both modals can reference the shared CSS
// module without each importing the raw CSS file.
export const AI_GRID_LOCK_CLASS = styles.gridShellAiLocked;
