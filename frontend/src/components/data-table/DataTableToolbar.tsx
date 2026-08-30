import { Flex } from 'antd';
import type { ReactNode } from 'react';

export function DataTableToolbar({
  leading,
  trailing,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <Flex className="nc-devices-toolbar" align="center" justify="space-between" gap={8} wrap>
      <Flex gap={8} wrap align="center">
        {leading}
      </Flex>
      <Flex gap={8} wrap align="center">
        {trailing}
      </Flex>
    </Flex>
  );
}
