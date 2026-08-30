import { Card, Col, Descriptions, List, Row, Switch, Tag, Typography } from 'antd';
import { useTheme } from '@/components/theme-provider';
import { SITES } from '@/data/bank';

const modules = [
  { name: 'Frontend', stack: 'React + Vite + Ant Design 5', status: 'ready' },
  { name: 'Backend API', stack: 'Node.js + Express + Prisma — attach live devices later', status: 'ready' },
  { name: 'Database', stack: 'PostgreSQL 16', status: 'ready' },
  { name: 'Worker', stack: 'Python · SSH / REST Aruba CX', status: 'later' },
  { name: 'Discovery', stack: 'Scan mgmt → SSH/REST → sync → Generate Config', status: 'ready' },
  { name: 'Kea DHCP', stack: 'Datacenter HA · relay from NKKN / NTMK', status: 'later' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="nc-page">
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card bordered={false} title="NetConsole · bank fabric">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Site">
                {SITES.map((item) => `${item.code} (${item.floors} floors, VLAN ${item.vlanBase + 1}–${item.vlanBase + item.floors})`).join(' · ')}
              </Descriptions.Item>
              <Descriptions.Item label="Per-floor fabric">
                Dist 4 links down to SW01/SW02. SW03/SW04 uplink to the SW01/SW02 pair. One VLAN per floor. DHCP relay to Kea DC.
              </Descriptions.Item>
              <Descriptions.Item label="Initial rollout">
                Configure mgmt, enable SSH and REST → Discovery scans the mgmt range by site/floor → sync inventory → Generate Config from the app.
              </Descriptions.Item>
              <Descriptions.Item label="Theme">
                <Switch
                  checked={theme === 'dark'}
                  checkedChildren="Dark"
                  unCheckedChildren="Light"
                  onChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                />
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card bordered={false} title="Module">
            <List
              dataSource={modules}
              renderItem={(module) => (
                <List.Item extra={<Tag color={module.status === 'ready' ? 'success' : 'warning'}>{module.status}</Tag>}>
                  <List.Item.Meta
                    title={module.name}
                    description={<Typography.Text type="secondary">{module.stack}</Typography.Text>}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
