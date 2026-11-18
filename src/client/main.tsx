import '@fontsource/doto/latin-900.css';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import '@fontsource/geist-mono/latin-600.css';
// base.css first: every other stylesheet builds on its tokens, and a stylesheet loads in the order it is imported.
import './base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { start } from './api.js';
import { startLivery } from './look.js';

// The token is read (and its fragment removed) before anything renders, so that no later code sees it in the address bar.
start();
// the look of the last visit is on the page before the first render, so that a dark livery never flashes light
startLivery();

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
