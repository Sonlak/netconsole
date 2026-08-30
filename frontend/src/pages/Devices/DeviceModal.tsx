import { useEffect } from 'react';
import { Form, Input, Modal, Select } from 'antd';
import { floorFromHostname, siteFromHostname } from '@/data/bank';
import { DEVICE_FORM_STATUS_OPTIONS, type Device, type DeviceInput } from '@/types/device';

type DeviceModalProps = {
  open: boolean;
  saving: boolean;
  device?: Device | null;
  onClose: () => void;
  onSubmit: (values: DeviceInput) => Promise<void>;
};

export function DeviceModal({ open, saving, device, onClose, onSubmit }: DeviceModalProps) {
  const [form] = Form.useForm<DeviceInput>();
  const mode = device ? 'edit' : 'add';

  useEffect(() => {
    if (!open) return;
    if (device) {
      form.setFieldsValue({
        site: device.site,
        floor: device.floor,
        name: device.name,
        ip: device.ip,
        status: device.status === 'MAINTENANCE' ? 'MAINTENANCE' : 'UNKNOWN',
        vendor: device.vendor,
        model: device.model,
        version: device.version,
        serial: device.serial,
        description: device.description ?? '',
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ status: 'UNKNOWN', site: 'LAB' });
    }
  }, [open, device, form]);

  return (
    <Modal
      open={open}
      title={mode === 'add' ? 'Add device' : 'Edit device'}
      okText={mode === 'add' ? 'Add' : 'Update'}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={async () => {
        const values = await form.validateFields();
        await onSubmit(values);
      }}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <div className="nc-form-grid">
          <Form.Item name="site" label="Site" rules={[{ required: true, message: 'Enter site' }]}>
            <Input placeholder="LAB" />
          </Form.Item>
          <Form.Item name="floor" label="Floor" rules={[{ required: true, message: 'Enter floor' }]}>
            <Input placeholder="1" />
          </Form.Item>
          <Form.Item name="name" label="Device name" rules={[{ required: true, message: 'Enter name' }]}>
            <Input
              placeholder="LAB-F1-AS-01"
              onChange={(event) => {
                const fromName = floorFromHostname(event.target.value);
                if (fromName) form.setFieldValue('floor', fromName);
                const site = siteFromHostname(event.target.value);
                if (site) form.setFieldValue('site', site);
              }}
            />
          </Form.Item>
          <Form.Item
            name="ip"
            label="IP"
            rules={[
              { required: true, message: 'Enter IP' },
              { pattern: /^(\d{1,3}\.){3}\d{1,3}$/, message: 'Invalid IP' },
            ]}
          >
            <Input placeholder="10.11.0.1" />
          </Form.Item>
          <Form.Item name="status" label="Status mode">
            <Select options={DEVICE_FORM_STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item name="vendor" label="Vendor" rules={[{ required: true, message: 'Enter vendor' }]}>
            <Input placeholder="Aruba" />
          </Form.Item>
          <Form.Item name="model" label="Model" rules={[{ required: true, message: 'Enter model' }]}>
            <Input placeholder="8360-32Y" />
          </Form.Item>
          <Form.Item name="version" label="Version" rules={[{ required: true, message: 'Enter version' }]}>
            <Input placeholder="10.13.1000" />
          </Form.Item>
          <Form.Item name="serial" label="Serial" rules={[{ required: true, message: 'Enter serial' }]} className="nc-form-span-2">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description" className="nc-form-span-2">
            <Input.TextArea rows={3} placeholder="Location, role, notes..." />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
