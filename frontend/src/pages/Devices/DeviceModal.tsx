import { useEffect } from 'react';
import { AutoComplete, Form, Input, Modal, Select } from 'antd';
import { floorFromHostname, siteFromHostname } from '@/data/bank';
import { DEVICE_FORM_STATUS_OPTIONS, type Device, type DeviceInput } from '@/types/device';

type DeviceModalProps = {
  open: boolean;
  saving: boolean;
  device?: Device | null;
  onClose: () => void;
  onSubmit: (values: DeviceInput) => Promise<void>;
};

// Vendor options + per-vendor model suggestions. The model list is a
// hint, not a constraint — operators can type free text if their SKU
// isn't listed. The vendor value is what the worker reads to pick the
// backend (`netconsole_worker.vendor.detect_vendor`).
const VENDOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Juniper', label: 'Juniper' },
  { value: 'Arista', label: 'Arista EOS' },
  { value: 'Cisco IOS-XE', label: 'Cisco IOS-XE (Catalyst/ASR/ISR/CSR)' },
  { value: 'Cisco Nexus', label: 'Cisco NX-OS (Nexus)' },
];

const MODEL_HINTS: Record<string, string[]> = {
  Juniper: ['EX4300-48P', 'EX9208', 'MX204', 'MX480', 'QFX5120-48Y', 'SRX4100'],
  Arista: ['DCS-7280SR3-48YC6', 'DCS-7504', 'CCS-720XP-48Y6', 'DCS-7050CX3-32S'],
  'Cisco IOS-XE': [
    'C9300-48P',
    'C9500-40X',
    'C9600-SUP-1',
    'ASR-1001-HX',
    'ISR-4451-X',
    'CSR-1000v',
  ],
  'Cisco Nexus': ['N9K-C93180YC-FX', 'N9K-C9336C-FX2', 'N3K-C3172PQ', 'N7K-M3248'],
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
          <Form.Item
            name="vendor"
            label="Vendor"
            rules={[{ required: true, message: 'Pick a vendor' }]}
          >
            <Select
              showSearch
              placeholder="Pick a vendor"
              options={VENDOR_OPTIONS}
              onChange={(value) => {
                // Pre-fill model with the first common SKU for the vendor
                // so the operator doesn't have to retype. They can still
                // override afterwards.
                const hints = MODEL_HINTS[value as string];
                if (hints && hints.length > 0) {
                  form.setFieldValue('model', hints[0]);
                }
              }}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.vendor !== curr.vendor}
          >
            {() => (
              <Form.Item name="model" label="Model" rules={[{ required: true, message: 'Enter model' }]}>
                <AutoComplete
                  options={(MODEL_HINTS[form.getFieldValue('vendor') as string] || []).map((m) => ({
                    value: m,
                  }))}
                  placeholder="C9300-48P / N9K-C93180YC-FX / DCS-7280SR3..."
                  filterOption={(input, option) =>
                    (option?.value as string).toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            )}
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
