'use client';

import { useEffect } from 'react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export default function PWAInstallBridge() {
  useEffect(() => {
    let deferredPrompt: InstallPromptEvent | null = null;

    const isStandalone = () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

    const notify = () => {
      window.dispatchEvent(
        new CustomEvent('hsware:pwa-state', {
          detail: {
            installed: isStandalone(),
            installable: Boolean(deferredPrompt) && !isStandalone(),
          },
        }),
      );
    };

    const api = {
      isInstalled: isStandalone,
      canInstall: () => Boolean(deferredPrompt) && !isStandalone(),
      install: async () => {
        if (isStandalone()) return { outcome: 'installed' as const };
        if (!deferredPrompt) return { outcome: 'unavailable' as const };

        const prompt = deferredPrompt;
        deferredPrompt = null;
        await prompt.prompt();
        const choice = await prompt.userChoice;
        notify();
        return choice;
      },
    };

    (window as Window & { __hswarePWA?: typeof api }).__hswarePWA = api;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredPrompt = event as InstallPromptEvent;
      notify();
    };

    const onInstalled = () => {
      deferredPrompt = null;
      notify();
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // PWA registration failure must never affect the HSWare workspace.
      });
    }

    notify();

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      delete (window as Window & { __hswarePWA?: typeof api }).__hswarePWA;
    };
  }, []);

  return null;
}
