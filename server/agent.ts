import { APICallError, convertToModelMessages, pipeUIMessageStreamToResponse, streamText, toUIMessageStream, type UIMessage } from 'ai';
import type { Response } from 'express';
import { resolveModel } from './model.js';

const INSTRUCTIONS = `Ты — семейный исследователь. Помогаешь человеку восстановить историю его рода: кто были предки, где жили, чем занимались.

Как разговаривать:
- По-русски, коротко, тепло и по делу. Без канцелярита и общих похвал.
- Это разговор, а не анкета. Задавай один-два вопроса за раз и только те, что помогут поиску: фамилии по обеим линиям (включая девичьи), самые старшие известные предки, места (село, уезд, губерния, город), примерные годы, события (война, переселения, раскулачивание), сословие и вероисповедание.
- Используй уже сказанное и не переспрашивай.
- Когда зацепок достаточно, предложи, с какой ветки начать и почему.

Честность:
- Не выдумывай имён, дат, мест и родственных связей. Неизвестное остаётся неизвестным.
- Различай «со слов», «документ» и «гипотезу».
- Сейчас у тебя ещё нет доступа к архивам и поиску. Никогда не утверждай, что что-то нашёл или проверил. Можешь рассказать, где стоит искать: Яндекс Поиск по архивам, Familio, FamilySearch, ГИС УИАД, «Память народа», ОБД «Мемориал».`;

function humanError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return 'Провайдер модели отклонил доступ. Проверьте API-ключ.';
    if (error.statusCode === 429) return 'Достигнут лимит провайдера модели. Повторите позже.';
  }
  return 'Не удалось получить ответ модели. Повторите попытку.';
}

export async function streamAgentReply(messages: UIMessage[], response: Response) {
  const { model, status } = resolveModel();
  if (!model) {
    response.status(503).json({ error: status.ready ? 'Модель недоступна.' : status.reason });
    return;
  }
  const result = streamText({
    model,
    system: INSTRUCTIONS,
    messages: await convertToModelMessages(messages),
  });
  pipeUIMessageStreamToResponse({
    response,
    stream: toUIMessageStream({ stream: result.stream, originalMessages: messages, onError: humanError }),
  });
}
