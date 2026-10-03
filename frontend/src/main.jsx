/**
 * Browser entry point: mounts the React tree into #root inside the router and the
 * session provider. StrictMode double-invokes effects in development to surface missing
 * cleanups (for example, an in-flight request that is not aborted on unmount).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
