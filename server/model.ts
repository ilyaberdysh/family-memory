import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export type ModelStatus = { ready: true; provider: string; model: string } | { ready: false; reason: string };

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.5',
  anthropic: 'claude-opus-5-5',
};

/** Provider is chosen by env so the model decision can wait. */
export function resolveModel(): { model: LanguageModel; status: ModelStatus } | { model: null; status: ModelStatus } {
  const provider = (process.env.AI_PROVIDER ?? 'openai').toLowerCase();
  const modelId = process.env.AI_MODEL || DEFAULT_MODELS[provider];
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) return { model: null, status: { ready: false, reason: 'Не задан OPENAI_API_KEY.' } };
    return { model: createOpenAI()(modelId), status: { ready: true, provider, model: modelId } };
  }
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return { model: null, status: { ready: false, reason: 'Не задан ANTHROPIC_API_KEY.' } };
    return { model: createAnthropic()(modelId), status: { ready: true, provider, model: modelId } };
  }
  return { model: null, status: { ready: false, reason: `Неизвестный AI_PROVIDER: ${provider}.` } };
}
