/**
 * Frontend API wrapper for the interface-counter poller (see backend
 * `services/interfaceCounters.ts` for the wiring).
 *
 *   GET  /api/devices/:deviceId/interface-counters/latest
 *     → { deviceId, capturedAt, interfaces: Array<CounterSampleJson> }
 *
 *   GET  /api/devices/:deviceId/interface-counters/history?interface=X&sinceMinutes=N
 *     → { deviceId, interfaces: Array<{ interfaceName, samples, rates }> }
 *
 *   POST /api/devices/:deviceId/interface-counters/refresh
 *     → { ok, sampleCount, source, collectMs }
 *
 * All BigInt values come back as **strings** (Express can't serialize BigInt
 * natively) so keep that in mind when computing rates client-side. The
 * backend already returns derived `inBps/outBps` for the chart.
 */
import { authFetch, handleResponse } from './http';

export type CounterSampleJson = {
  id: string;
  deviceId: string;
  interfaceName: string;
  source: string;
  capturedAt: string;
  inOctets: string | null;
  outOctets: string | null;
  inPackets: string | null;
  outPackets: string | null;
  inErrors: string | null;
  outErrors: string | null;
  inDiscards: string | null;
  outDiscards: string | null;
  inCrcErrors: string | null;
};

export type CounterRates = Array<{ t: string; inBps: number | null; outBps: number | null }>;

export type CounterHistory = {
  deviceId: string;
  interfaces: Array<{
    interfaceName: string;
    samples: CounterSampleJson[];
    rates: CounterRates;
  }>;
};

export type LatestCounters = {
  deviceId: string;
  capturedAt: string | null;
  interfaces: CounterSampleJson[];
};

const BASE = '/api/devices';

export async function fetchLatestCounters(deviceId: string): Promise<LatestCounters> {
  const response = await authFetch(`${BASE}/${deviceId}/interface-counters/latest`);
  return handleResponse<LatestCounters>(response);
}

export async function fetchCounterHistory(
  deviceId: string,
  options: { interfaceName?: string; sinceMinutes?: number } = {},
): Promise<CounterHistory> {
  const params = new URLSearchParams();
  if (options.interfaceName) params.set('interface', options.interfaceName);
  if (options.sinceMinutes) params.set('sinceMinutes', String(options.sinceMinutes));
  const qs = params.toString();
  const response = await authFetch(
    `${BASE}/${deviceId}/interface-counters/history${qs ? `?${qs}` : ''}`,
  );
  return handleResponse<CounterHistory>(response);
}

export async function refreshDeviceCounters(
  deviceId: string,
): Promise<{ ok: boolean; sampleCount: number; source?: string; collectMs: number; error?: string }> {
  const response = await authFetch(`${BASE}/${deviceId}/interface-counters/refresh`, {
    method: 'POST',
  });
  return handleResponse(response);
}
