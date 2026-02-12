import React from "react";
import type { DuplicateWarningGroup } from "../lib/useDuplicateCheck";
import styles from "./DuplicateWarning.module.css";

type Props = {
  warnings: DuplicateWarningGroup[];
};

const WarningIcon = () => (
  <svg
    className={styles.warningIcon}
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
      clipRule="evenodd"
    />
  </svg>
);

export default function DuplicateWarning({ warnings }: Props) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <div className={styles.container}>
      {warnings.map((group) => (
        <div key={group.type} className={styles.warningGroup}>
          <div className={styles.warningHeader}>
            <WarningIcon />
            {group.label} ({group.matches.length})
          </div>
          <ul className={styles.matchList}>
            {group.matches.map((match) => (
              <li key={match.id} className={styles.matchItem}>
                <span className={styles.matchName}>{match.name}</span>
                {match.taxId ? (
                  <span className={styles.matchDetail}> &mdash; Tax ID: {match.taxId}</span>
                ) : null}
                {match.partNumber ? (
                  <span className={styles.matchDetail}> &mdash; PN: {match.partNumber}</span>
                ) : null}
                {match.modelNumber ? (
                  <span className={styles.matchDetail}> &mdash; MN: {match.modelNumber}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
