import type { Device } from '@/types/device';
import type { InterfaceDeviceOption } from '@/types/interfaces';

export function toInterfaceOption(device: Device): InterfaceDeviceOption {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    site: device.site,
    floor: device.floor,
    status: device.status,
    vendor: device.vendor,
    model: device.model,
  };
}
