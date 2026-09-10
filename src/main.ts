import { Radio } from './core/radio';
import { InfoPanel } from './app/info';
import { RadioUI } from './app/ui';
import './app/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');

const radio = new Radio();
new RadioUI(radio, root).mount();

// Outside #app, which the radio clears when it mounts.
const info = new InfoPanel();
info.mount(document.body);
void info.greet();

void radio.init();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
