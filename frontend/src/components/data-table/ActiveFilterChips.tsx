import { Button, Tag } from 'antd';

export type FilterChip = { key: string; label: string };

export function ActiveFilterChips({
  chips,
  onClear,
}: {
  chips: FilterChip[];
  onClear: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="nc-filter-chips">
      {chips.map((chip) => (
        <Tag key={chip.key}>{chip.label}</Tag>
      ))}
      <Button type="link" size="small" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
