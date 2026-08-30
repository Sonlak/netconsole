import { Flex, Spin } from 'antd';

export function PageLoader() {
  return (
    <Flex align="center" justify="center" style={{ minHeight: 240 }}>
      <Spin />
    </Flex>
  );
}
