'use client';

const AI_STORAGE_KEYS = {
  provider: 'archi-navi:ai-provider',
  apiKey: 'archi-navi:ai-api-key',
  model: 'archi-navi:ai-model',
} as const;

function getTrimmedLocalStorageItem(key: string): string | null {
  try {
    const value = localStorage.getItem(key)?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function getClientAiRequestHeaders(): Record<string, string> {
  const provider = getTrimmedLocalStorageItem(AI_STORAGE_KEYS.provider);
  const apiKey = getTrimmedLocalStorageItem(AI_STORAGE_KEYS.apiKey);
  const model = getTrimmedLocalStorageItem(AI_STORAGE_KEYS.model);

  const headers: Record<string, string> = {};
  if (provider) headers['x-ai-provider'] = provider;
  if (apiKey) headers['x-ai-api-key'] = apiKey;
  if (model) headers['x-ai-model'] = model;
  return headers;
}
