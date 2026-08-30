import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { SITES, type SiteFilter, isKnownSite } from '@/data/bank';

const STORAGE_KEY = 'nc-site';

function readSite(): SiteFilter {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'all' || isKnownSite(value || '')) return value as SiteFilter;
  } catch {
    // ignore
  }
  return 'all';
}

const SiteContext = createContext<{
  site: SiteFilter;
  setSite: (site: SiteFilter) => void;
} | null>(null);

export function SiteProvider({ children }: { children: ReactNode }) {
  const [site, setSiteState] = useState<SiteFilter>(readSite);

  const value = useMemo(
    () => ({
      site,
      setSite: (next: SiteFilter) => {
        setSiteState(next);
        localStorage.setItem(STORAGE_KEY, next);
      },
    }),
    [site],
  );

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error('useSite must be used within SiteProvider');
  return ctx;
}

export const SITE_OPTIONS: { value: SiteFilter; label: string }[] = [
  { value: 'all', label: 'All sites' },
  ...SITES.map((item) => ({ value: item.code as SiteFilter, label: item.code })),
];
