import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { live } from './lib/live';
import './index.css';

/**
 * Entry point.
 *
 * The socket is opened before React mounts so the `hello` frame - services,
 * topology, current states and open alerts - is already decoded by the time the
 * first screen paints. The store is a singleton precisely so this ordering is
 * possible.
 */

live.connect();

const container = document.getElementById('root');
if (!container) throw new Error('console root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
