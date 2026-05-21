// grok-remote PWA glue.
//
// Responsibilities:
//   1. Register the service worker (when allowed by browser + protocol).
//   2. Capture the `beforeinstallprompt` event for one-tap install.
//   3. Drive the #install-banner element (show/hide, button wiring).
//   4. Provide a manual hint for iOS Safari, which never fires the prompt event.

interface BeforeInstallPromptEvent extends Event {
  prompt(): void;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' | string; platform?: string }>;
}

interface SafariNavigator extends Navigator {
  standalone?: boolean;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let bannerEl: HTMLElement | null = null;

const isIos = (): boolean =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent || '');

export function isInstalled(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes navigator.standalone instead.
  if (typeof navigator !== 'undefined' && (navigator as SafariNavigator).standalone === true) return true;
  return false;
}

export function canInstall(): boolean {
  if (isInstalled()) return false;
  if (deferredPrompt) return true;
  if (isIos()) return true;
  return false;
}

function dismissed(): boolean {
  try {
    return sessionStorage.getItem('install-dismissed') === '1';
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    sessionStorage.setItem('install-dismissed', '1');
  } catch { /* ignore */ }
}

function updateBanner(): void {
  if (!bannerEl) bannerEl = document.getElementById('install-banner');
  if (!bannerEl) return;
  if (canInstall() && !dismissed()) {
    bannerEl.hidden = false;
    const label = bannerEl.querySelector('[data-role="label"]');
    const installBtn = bannerEl.querySelector('[data-action="install"]');
    if (isIos() && !deferredPrompt) {
      if (label) label.textContent = 'Install: tap Share, then Add to Home Screen.';
      if (installBtn) installBtn.textContent = 'Got it';
    } else {
      if (label) label.textContent = 'Install Grok Remote as an app.';
      if (installBtn) installBtn.textContent = 'Install';
    }
  } else {
    bannerEl.hidden = true;
  }
}

export interface InstallResult {
  outcome: string;
  platform?: string;
}

export async function installApp(): Promise<InstallResult> {
  if (isIos() && !deferredPrompt) {
    setDismissed();
    updateBanner();
    return { outcome: 'ios-hint' };
  }
  if (!deferredPrompt) return { outcome: 'unavailable' };
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice && choice.outcome === 'accepted') {
      setDismissed();
    }
    updateBanner();
    return choice || { outcome: 'unknown' };
  } catch {
    deferredPrompt = null;
    updateBanner();
    return { outcome: 'error' };
  }
}

export function dismissInstall(): void {
  setDismissed();
  updateBanner();
}

export function registerPwa(): void {
  if (typeof window === 'undefined') return;

  bannerEl = document.getElementById('install-banner');
  if (bannerEl && !bannerEl.dataset['wired']) {
    bannerEl.dataset['wired'] = '1';
    bannerEl.addEventListener('click', (ev: MouseEvent) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');
      if (action === 'install') {
        ev.preventDefault();
        void installApp();
      } else if (action === 'dismiss') {
        ev.preventDefault();
        dismissInstall();
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (ev: Event) => {
    ev.preventDefault();
    deferredPrompt = ev as BeforeInstallPromptEvent;
    updateBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setDismissed();
    updateBanner();
  });

  updateBanner();

  if ('serviceWorker' in navigator) {
    const host = location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (location.protocol === 'https:' || isLocal) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // swallow; SW registration is best-effort.
        });
      });
    }
  }
}
