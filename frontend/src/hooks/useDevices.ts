import { useCallback, useEffect, useState } from 'react';
import { createDevice, deleteDevice, fetchDevices, updateDevice } from '@/api/devices';
import { toError } from '@/lib/errors';
import type { Device, DeviceInput } from '@/types/device';

export function useDevices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refetch = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (silent) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      const next = await fetchDevices();
      setDevices(Array.isArray(next) ? next : []);
      setError(null);
      setLastUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(toError(cause, 'Could not load devices'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const addDevice = useCallback(
    async (values: DeviceInput) => {
      await createDevice(values);
      await refetch({ silent: true });
    },
    [refetch],
  );

  const saveDevice = useCallback(
    async (id: string, values: DeviceInput) => {
      await updateDevice(id, values);
      await refetch({ silent: true });
    },
    [refetch],
  );

  const removeDevice = useCallback(
    async (id: string) => {
      await deleteDevice(id);
      await refetch({ silent: true });
    },
    [refetch],
  );

  return {
    devices,
    setDevices,
    isLoading,
    isRefreshing,
    error,
    lastUpdatedAt,
    refetch,
    addDevice,
    saveDevice,
    removeDevice,
  };
}
