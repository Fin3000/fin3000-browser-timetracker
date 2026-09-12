import { captureTarget } from './capture.js';

// Isolated-world listener: retain a node reference, never its text, until the
// browser's explicit Fin3000 menu action requests this exact frame.
let clicked: { target: WeakRef<Element>; at: number } | null = null;
const clear = (): void => { clicked = null; };
addEventListener('pointerdown', (event) => { if (event.isTrusted) clear(); }, true);
addEventListener('keydown', (event) => { if (event.isTrusted) clear(); }, true);
addEventListener('pagehide', clear, true);
addEventListener('contextmenu', (event) => {
  clear();
  if (!event.isTrusted || !/^https?:$/.test(location.protocol)) return;
  const target = event.composedPath()[0];
  if (target instanceof Element)
    clicked = { target: new WeakRef(target), at: Date.now() };
}, true);
browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || sender.tab ||
      sender.url !== browser.runtime.getURL('src/background.js') ||
      !message || typeof message !== 'object' ||
      Object.keys(message).join() !== 'type' ||
      (message as { type?: unknown }).type !== 'fin3000.capture') return undefined;
  const previous = clicked;
  clear();
  const target = previous?.target.deref();
  const age = previous ? Date.now() - previous.at : -1;
  return Promise.resolve(target && age >= 0 && age <= 120_000 ? captureTarget(target) : null);
});
