import { requestPersistence } from './core/db';
import { Radio } from './core/radio';
import { RadioUI } from './app/ui';
import './app/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');

const radio = new Radio();
new RadioUI(radio, root).mount();

void radio.init();
// Imported audio lives in IndexedDB; ask to keep it out of the eviction path.
void requestPersistence();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
