/** Provides the NSK drawer's open state (nskDrawerState.js); mounted by AppShell for use_nsk_assistant. */

import { useCallback, useMemo, useState } from 'react';
import { NskDrawerContext } from './nskDrawerState.js';

export function NskDrawerProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isAvailable: true, isOpen, open, close }), [isOpen, open, close]);
  return <NskDrawerContext.Provider value={value}>{children}</NskDrawerContext.Provider>;
}
