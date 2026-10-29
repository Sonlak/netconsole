/**
 * Tests for the proxy-aware OpenAI client in `llmClient.ts`.
 *
 * Caught 2026-10-29 on production: the prod VPS has NO direct internet
 * egress — every outbound connection goes through the site HTTP proxy
 * (`192.168.154.101:1985`). Node's built-in `fetch` (undici) does NOT
 * read `HTTPS_PROXY` by default, so the OpenAI SDK timed out with
 * `UND_ERR_CONNECT_TIMEOUT` and the assistant never produced a token.
 *
 * The client now installs an undici `ProxyAgent` dispatcher when a proxy
 * is configured. These tests exercise the URL resolution only — no
 * network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
}

async function loadModule() {
  return await import('../../../src/services/assistant/llmClient.js');
}

describe('assistant llmClient proxy configuration', () => {
  beforeEach(() => {
    restoreEnv();
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.OPENAI_PROXY_URL;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('resolves no proxy when nothing is configured', async () => {
    const { _resolveProxyUrl } = await loadModule();
    expect(_resolveProxyUrl()).toBeNull();
  });

  it('prefers OPENAI_PROXY_URL over HTTPS_PROXY', async () => {
    process.env.OPENAI_PROXY_URL = 'http://192.168.154.101:1985';
    process.env.HTTPS_PROXY = 'http://other:3128';
    const { _resolveProxyUrl } = await loadModule();
    expect(_resolveProxyUrl()).toBe('http://192.168.154.101:1985/');
  });

  it('falls back to HTTPS_PROXY when OPENAI_PROXY_URL is absent', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example:3128';
    const { _resolveProxyUrl } = await loadModule();
    expect(_resolveProxyUrl()).toBe('http://proxy.example:3128/');
  });

  it('ignores a malformed proxy URL instead of crashing', async () => {
    process.env.OPENAI_PROXY_URL = 'http://[not a url';
    const { _resolveProxyUrl } = await loadModule();
    expect(_resolveProxyUrl()).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid proxy URL'),
    );
  });

  it('treats an empty OPENAI_PROXY_URL as "no proxy"', async () => {
    process.env.OPENAI_PROXY_URL = '   ';
    const { _resolveProxyUrl } = await loadModule();
    expect(_resolveProxyUrl()).toBeNull();
  });

  it('defaults the model to gpt-4o-mini when OPENAI_MODEL is unset', async () => {
    delete process.env.OPENAI_MODEL;
    const { defaultModel } = await loadModule();
    expect(defaultModel()).toBe('gpt-4o-mini');
  });

  it('falls back to gpt-4o-mini for an unknown OPENAI_MODEL', async () => {
    process.env.OPENAI_MODEL = 'gpt-9000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { defaultModel } = await loadModule();
    expect(defaultModel()).toBe('gpt-4o-mini');
  });
});
