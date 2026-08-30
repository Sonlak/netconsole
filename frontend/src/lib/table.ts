export const tablePagination = {
  defaultPageSize: 20,
  showSizeChanger: true,
  size: 'small' as const,
  showTotal: (total: number) => `${total} loaded`,
  pageSizeOptions: [10, 20, 50, 100],
};

export const tableScroll = { x: 'max-content' as const };
