/**
 * Whether the NSK drawer is open, shared by everything that opens it (the top bar, the sidebar, the
 * mobile header) and the drawer itself; NskDrawerProvider.jsx provides it for people with
 * use_nsk_assistant only. Without the provider, useNskDrawer reports the assistant as unavailable.
 */

import { createContext, useContext } from 'react';

export const NskDrawerContext = createContext({ isAvailable: false, isOpen: false, open: () => {}, close: () => {} });

export const useNskDrawer = () => useContext(NskDrawerContext);
