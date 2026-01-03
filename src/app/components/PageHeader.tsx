'use client';

import React, { type PropsWithChildren, createContext, useCallback, useState } from 'react';
import styles from './PageHeader.module.css';

export const PageHeaderContext = createContext<HTMLDivElement | null>(null);

type PageHeaderProps = PropsWithChildren<{
  title: React.ReactNode;
  leftActions?: React.ReactNode;
  rightActions?: React.ReactNode;
  className?: string;
  headingClassName?: string;
  hideTitle?: boolean;
}>;

export default function PageHeader({
  title,
  leftActions,
  rightActions,
  children,
  className,
  hideTitle,
  headingClassName,
}: PageHeaderProps) {
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const handleSlotRef = useCallback((node: HTMLDivElement | null) => {
    setSearchSlot(node);
  }, []);
  const rowClassName = className ? `${styles.headerRow} ${className}` : styles.headerRow;
  const headingClasses = [styles.heading, headingClassName].filter(Boolean).join(' ');

  return (
    <PageHeaderContext.Provider value={searchSlot}>
      <div className={rowClassName}>
        <div className={`${styles.headerSide} ${styles.headerSideLeft}`}>
          {leftActions}
          <div ref={handleSlotRef} className={styles.searchSlot} />
        </div>
        {hideTitle ? null : <h1 className={headingClasses}>{title}</h1>}
        <div className={`${styles.headerSide} ${styles.headerSideRight}`}>{rightActions}</div>
      </div>
      {children}
    </PageHeaderContext.Provider>
  );
}
