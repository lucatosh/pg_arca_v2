import { useEffect, useState } from 'react';
export interface Route { page: 'clusters' | 'cluster' | 'audit' | 'discovery' | 'strategy' | 'users'; id?: string; tab?: string }
export function parse(h: string): Route {
  const p = h.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'c' && p[1]) return { page: 'cluster', id: decodeURIComponent(p[1]), tab: p[2] };
  if (p[0] === 'audit') return { page: 'audit' };
  if (p[0] === 'users') return { page: 'users' };
  if (p[0] === 'strategy') return { page: 'strategy' };
  if (p[0] === 'discovery') return { page: 'discovery' };
  return { page: 'clusters' };
}
export const href = (r: string) => `#/${r}`;
export const go = (r: string) => { location.hash = `#/${r}`; };
export function useRoute(): Route {
  const [r, setR] = useState(() => parse(location.hash));
  useEffect(() => { const f = () => setR(parse(location.hash)); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
}
