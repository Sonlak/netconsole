import { useEffect, useRef } from 'react';
import { useSite } from '@/components/site-provider';
import { isKnownSite, type SiteFilter } from '@/data/bank';
import { useUrlState } from '@/hooks/useUrlState';

function parseSite(value: string | undefined): SiteFilter | undefined {
  if (value === 'all' || (value && isKnownSite(value))) {
    return value as SiteFilter;
  }
  return undefined;
}

export function useSiteFilter(options?: { deviceKey?: string; floorKey?: string }) {
  const floorKey = options?.floorKey ?? 'floor';
  const deviceKey = options?.deviceKey ?? 'device';
  const { site: headerSite, setSite: setHeaderSite } = useSite();
  const { get, patch } = useUrlState();
  const urlSite = parseSite(get('site'));
  const site: SiteFilter = urlSite ?? headerSite;
  const prevHeader = useRef(headerSite);

  useEffect(() => {
    if (prevHeader.current === headerSite) return;
    prevHeader.current = headerSite;
    patch({
      site: headerSite === 'all' ? null : headerSite,
      [floorKey]: null,
      [deviceKey]: null,
    });
  }, [deviceKey, floorKey, headerSite, patch]);

  const setSite = (next: SiteFilter) => {
    setHeaderSite(next);
    prevHeader.current = next;
    patch({
      site: next === 'all' ? null : next,
      [floorKey]: null,
      [deviceKey]: null,
    });
  };

  return { site, setSite, get, patch };
}
