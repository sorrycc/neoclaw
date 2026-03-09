import { useEffect, useState } from 'react';

const NAVIGATE_EVENT = 'neoclaw:navigate';

export function navigate(path: string, options?: { replace?: boolean }): void {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const method = options?.replace ? 'replaceState' : 'pushState';
  window.history[method](null, '', normalized);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname || '/');

  useEffect(() => {
    const update = () => setPathname(window.location.pathname || '/');
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);

  return pathname;
}
