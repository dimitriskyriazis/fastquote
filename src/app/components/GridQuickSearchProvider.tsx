'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { PageHeaderContext } from './PageHeader';
import QuickSearchToolbar from './QuickSearchToolbar';

type QuickSearchContextValue = {
  value: string;
  onChange: (value: string) => void;
  focus: () => void;
};

export const GridQuickSearchContext = createContext<QuickSearchContextValue | null>(null);

type Props = {
  children: React.ReactNode;
};

export function GridQuickSearchProvider({ children }: Props) {
  const headerSearchSlot = useContext(PageHeaderContext);
  const [value, setValue] = useState('');
  const focusHandlerRef = useRef<(() => void) | null>(null);
  const registerFocusHandler = useCallback((handler: (() => void) | null) => {
    focusHandlerRef.current = handler;
  }, []);
  const focusQuickSearch = useCallback(() => {
    focusHandlerRef.current?.();
  }, []);
  const toolbar = headerSearchSlot
    ? createPortal(
        <QuickSearchToolbar
          value={value}
          onChange={setValue}
          onRegisterFocus={registerFocusHandler}
        />,
        headerSearchSlot,
      )
    : null;

  const contextValue = useMemo(
    () => ({ value, onChange: setValue, focus: focusQuickSearch }),
    [value, focusQuickSearch],
  );

  return (
    <GridQuickSearchContext.Provider value={contextValue}>
      {toolbar}
      {children}
    </GridQuickSearchContext.Provider>
  );
}
