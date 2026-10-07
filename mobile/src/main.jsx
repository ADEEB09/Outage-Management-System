// OLD crew web app (mobile/ workspace) entry — disabled. The crew app is now
// the Expo app at the repo root (index.js -> src/NativeApp.jsx) on both phone
// and web: `npm run dev` (or `npm run dev:mobile`) from the repo root -> :5174.
//
// import React from 'react';
// import { createRoot } from 'react-dom/client';
// import App from './App.jsx';
// import './app.css';
// import { initKeycloak } from './lib/auth.js';
//
// initKeycloak()
//   .then((authenticated) => {
//     if (authenticated) {
//       createRoot(document.getElementById('root')).render(<App />);
//     }
//   })
//   .catch((err) => {
//     console.error('Keycloak init failed', err);
//     document.getElementById('root').innerText = 'Could not reach the login server. Is Keycloak running?';
//   });
