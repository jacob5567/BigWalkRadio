import { Radio } from './core/radio';
import { RadioUI } from './app/ui';
import './app/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');

const radio = new Radio();
new RadioUI(radio, root).mount();

void radio.init();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
