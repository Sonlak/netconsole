import { EmptyState, FilteredEmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import type { ReactNode } from 'react';

export function DataTableState({
  loading,
  error,
  hasLoaded,
  isEmpty,
  filteredEmpty,
  onRetry,
  onClearFilters,
  empty,
}: {
  loading?: boolean;
  error?: Error | null;
  hasLoaded?: boolean;
  isEmpty?: boolean;
  filteredEmpty?: boolean;
  onRetry?: () => void;
  onClearFilters?: () => void;
  empty?: ReactNode;
}) {
  if (loading && !hasLoaded) return <PageSkeleton />;
  if (error && !hasLoaded) return <ErrorState error={error} onRetry={onRetry} />;
  if (filteredEmpty && onClearFilters) return <FilteredEmptyState onClear={onClearFilters} />;
  if (isEmpty) return empty ?? <EmptyState title="No rows" />;
  return null;
}
