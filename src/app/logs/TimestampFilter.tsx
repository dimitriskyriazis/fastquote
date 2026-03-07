"use client";

import React, { useState, useCallback } from "react";
import type { CustomFilterProps } from "ag-grid-react";
import { useGridFilter } from "ag-grid-react";
import styles from "./LogsClient.module.css";

function toInputValue(dateStr: string): string {
  if (!dateStr) return "";
  return dateStr.replace(" ", "T").slice(0, 16);
}

function toModelValue(inputVal: string): string {
  if (!inputVal) return "";
  return inputVal.replace("T", " ") + ":00";
}

function formatShort(dateStr: string): string {
  if (!dateStr) return "";
  return dateStr.slice(0, 16).replace("T", " ");
}

const FILTER_OPTIONS = [
  { value: "greaterThan", label: "After" },
  { value: "lessThan", label: "Before" },
  { value: "inRange", label: "Between" },
  { value: "equals", label: "Equals" },
  { value: "notEqual", label: "Not Equal" },
  { value: "greaterThanOrEqual", label: "On or After" },
  { value: "lessThanOrEqual", label: "On or Before" },
  { value: "blank", label: "Blank" },
  { value: "notBlank", label: "Not Blank" },
];

const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  FILTER_OPTIONS.map((o) => [o.value, o.label])
);

// Stable reference — prevents infinite re-render loop in AG Grid's setMethods
const doesFilterPass = () => true;

function getModelAsString(model: unknown): string {
  if (!model || typeof model !== "object") return "";
  const m = model as Record<string, string>;
  if (m.type === "blank") return "Blank";
  if (m.type === "notBlank") return "Not Blank";
  const label = TYPE_LABELS[m.type] || m.type;
  const from = formatShort(m.dateFrom || "");
  if (m.type === "inRange") {
    const to = formatShort(m.dateTo || "");
    return `${from} — ${to}`;
  }
  return `${label} ${from}`;
}

export default function TimestampFilter({
  model,
  onModelChange,
}: CustomFilterProps) {
  useGridFilter({ doesFilterPass, getModelAsString });

  const [localType, setLocalType] = useState<string>(
    model?.type || "greaterThan"
  );
  const [localFrom, setLocalFrom] = useState<string>(
    model?.dateFrom ? toInputValue(model.dateFrom) : ""
  );
  const [localTo, setLocalTo] = useState<string>(
    model?.dateTo ? toInputValue(model.dateTo) : ""
  );

  // React-approved pattern: sync local state from props during render
  const [prevModel, setPrevModel] = useState(model);
  if (model !== prevModel) {
    setPrevModel(model);
    if (model) {
      setLocalType(model.type || "greaterThan");
      setLocalFrom(model.dateFrom ? toInputValue(model.dateFrom) : "");
      setLocalTo(model.dateTo ? toInputValue(model.dateTo) : "");
    } else {
      setLocalType("greaterThan");
      setLocalFrom("");
      setLocalTo("");
    }
  }

  const applyFilter = useCallback(
    (newType: string, newFrom: string, newTo: string) => {
      if (newType === "blank" || newType === "notBlank") {
        onModelChange({ filterType: "date", type: newType });
        return;
      }
      if (!newFrom) {
        onModelChange(null);
        return;
      }
      if (newType === "inRange" && !newTo) {
        onModelChange(null);
        return;
      }
      const m: Record<string, unknown> = {
        filterType: "date",
        type: newType,
        dateFrom: toModelValue(newFrom),
      };
      if (newType === "inRange") {
        m.dateTo = toModelValue(newTo);
      }
      onModelChange(m);
    },
    [onModelChange]
  );

  const noInputNeeded = localType === "blank" || localType === "notBlank";

  const clearFilter = useCallback(() => {
    setLocalType("greaterThan");
    setLocalFrom("");
    setLocalTo("");
    onModelChange(null);
  }, [onModelChange]);

  return (
    <div className={styles.timestampFilter}>
      <select
        className={styles.timestampFilterSelect}
        value={localType}
        onChange={(e) => {
          const t = e.target.value;
          setLocalType(t);
          applyFilter(t, localFrom, localTo);
        }}
      >
        {FILTER_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {!noInputNeeded && (
        <>
          {localType === "inRange" && (
            <label className={styles.timestampFilterLabel}>From</label>
          )}
          <input
            type="datetime-local"
            className={styles.dateTimeInput}
            value={localFrom}
            onChange={(e) => {
              const v = e.target.value;
              setLocalFrom(v);
              applyFilter(localType, v, localTo);
            }}
          />
        </>
      )}
      {localType === "inRange" && (
        <>
          <label className={styles.timestampFilterLabel}>To</label>
          <input
            type="datetime-local"
            className={styles.dateTimeInput}
            value={localTo}
            onChange={(e) => {
              const v = e.target.value;
              setLocalTo(v);
              applyFilter(localType, localFrom, v);
            }}
          />
        </>
      )}
      <button
        type="button"
        className={styles.timestampFilterClear}
        onClick={clearFilter}
      >
        Clear
      </button>
    </div>
  );
}
