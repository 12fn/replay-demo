import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <div className="demo-frame">
      <div className="demo-content"><App /></div>
      <footer className="demo-data-notice" aria-label="Demo data notice">
        UNCLASSIFIED · PUBLIC / SYNTHETIC DATA · FOR DEMONSTRATION PURPOSES ONLY
      </footer>
    </div>
  </StrictMode>,
);
