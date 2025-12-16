'use client';

import React, { createContext, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PageHeaderContext } from './PageHeader';
import QuickSearchToolbar from './QuickSearchToolbar';

type QuickSearchContextValue = {
  value: string;
  onChange: (value: string) => void;
};

export const GridQuickSearchContext = createContext<QuickSearchContextValue | null>(null);

type Props = {
  children: React.ReactNode;
};

export function GridQuickSearchProvider({ children }: Props) {
  const headerSearchSlot = useContext(PageHeaderContext);
  const [value, setValue] = useState('');
  const toolbar = headerSearchSlot
    ? createPortal(
        <QuickSearchToolbar value={value} onChange={setValue} />,
        headerSearchSlot,
      )
    : null;

  const contextValue = useMemo(() => ({ value, onChange: setValue }), [value]);

  return (
    <GridQuickSearchContext.Provider value={contextValue}>
      {toolbar}
      {children}
    </GridQuickSearchContext.Provider>
  );
}
