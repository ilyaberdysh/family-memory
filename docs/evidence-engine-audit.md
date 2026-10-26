# Evidence engine: completion audit

Проверено 26 октября 2026 года относительно цели интеграции
`ex-ussr-kinship-research`.

| Требование | Реализация | Проверка |
| --- | --- | --- |
| 1. Полный upstream-снимок | `vendor/ex-ussr-kinship-research/`, MIT `LICENSE`, commit и процедура обновления в `UPSTREAM.md` | upstream `main` = `5a430a2e8eb11ccf45ef8ed8e49c6abb8a1436d0`; в снимке 23 upstream-файла |
| 2. Production-модель дела | `ResearchCase`, кандидаты, артефакты, claims, связи, independence groups и search log | unit-тесты хранилища и аудита |
| 3. Происхождение отдельных фактов | каждое имя, дата, место, заметка и связь создают отдельный claim; метка `Person.provenance` оставлена только для совместимости UI | конфликтующие даты сосуществуют; legacy fixture не меняется |
| 4. Древо остаётся простой проекцией | `tree.json` и undo сохранены; внешние кандидаты не получают `treePersonId` автоматически | legacy/undo store test, candidate-link test, live chat smoke |
| 5. Правила методологии | постоянное ядро, code-level evidence status checks и детерминированные policy directives | upstream logic evals, evidence invariant tests |
| 6. Модульный prompt | `research-instructions.ts` всегда даёт короткое ядро и выбирает только тематические references | router test и лимит объёма модулей |
| 7. ОБД через evidence pipeline | поиск пишет попытку и снимок выдачи; карточка создаёт артефакт, отдельного кандидата и атомарные claims; ошибки и CAPTCHA журналируются | OBD search/record/idempotency tests |
| 8. Инструменты дела | scope, inspect, candidate, artifact, claim, relationship, identity link, search log, audit и report | схемы tools собираются TypeScript; надёжные ID, даты и independence groups вычисляются кодом |
| 9. Исполняемые evals | тест читает непосредственно vendored `evals/discovery-and-logic.yaml`; отдельные invariant tests покрывают storage paths | 45 тестов проходят |
| 10. Структурный аудит | проверяются ссылки, дубли ID, ложная corroboration, сильные статусы, search coverage, CAPTCHA attempts и соответствие текущей проекции древа | audit tests и `/api/research/audit` smoke |
| 11. Документация | модель, поток, границы автоматизации и контракт нового адаптера описаны в README, плане и engineering plan | ручная сверка документов с кодом |
| 12. UI и AI SDK сохранены | React, текущий AI SDK, вкладки, дерево, карточки и визуальная система не заменялись | production build и HTTP smoke |

## Критерии готовности

- Старый `tree.json` без `history` читается; повреждённый JSON не заменяется пустым
  деревом.
- Сообщения пользователя сохраняются как идемпотентные артефакты, а изменения
  древа создают прослеживаемые claims.
- Идентичные повторы карточек и снимков выдачи ОБД не размножают артефакты;
  отдельные попытки поиска остаются в журнале.
- Однофамильцы и тёзки остаются отдельными кандидатами до явного подтверждения
  пользователя с обоснованием.
- Гипотетический промежуточный родственник принудительно оставляет оба ребра
  гипотезами. `document` нельзя записать без ссылки или архивного шифра.
- `npm test`: 45/45; `npm run build`: успешно; `git diff --check`: успешно.
- Production smoke на чистом хранилище: `/api/health`, `/api/tree`,
  `/api/research/audit` и `/api/research/report` отвечают корректно.

Известное не блокирующее предупреждение сборки: основной клиентский chunk больше
500 kB. Оно не появилось из-за evidence engine и не меняет корректность сборки.
