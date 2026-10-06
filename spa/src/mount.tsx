import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { loadAkariFont } from './lib/han-font';

const w = window as unknown as { __akariRoot?: Root };

export function start() {
  loadAkariFont();
  const container = document.getElementById('root');
  if (!container) return;

  if (!w.__akariRoot) {
    w.__akariRoot = createRoot(container);
  }

  w.__akariRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
