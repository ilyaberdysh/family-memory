# Evidence engine: reviewed implementation plan

## Decision

`ex-ussr-kinship-research` is the research methodology under the existing
product. The current React UI, conversation, tree, findings cards, undo and AI
SDK runtime remain. The canonical research record is no longer the rendered
tree: it is an evidence case from which the tree is a compact projection.

The upstream skill is vendored unchanged in
`vendor/ex-ussr-kinship-research/`. Product code imports no files from the
vendor snapshot directly except the instruction loader. This keeps provenance
and updates auditable while preventing product behavior from depending on the
user's personal Codex skills directory.

## Architecture review

The first plan was directionally correct but incomplete in four places:

1. **Atomic provenance capture.** Asking the model to remember URLs, access
   dates, IDs and independence groups is unreliable. Search and fetch wrappers
   must write those fields before returning results to the model.
2. **Legacy compatibility.** Replacing `tree.json` would put existing family
   data at risk. The evidence case therefore lives in a separate atomic file;
   current tree persistence and undo keep their existing format.
3. **Prompt size.** The full skill exceeds what should be sent every turn. A
   short invariant core is always present, while a deterministic router loads
   only relevant reference modules.
4. **Meaning of confirmation.** A user saying “это он” identifies a record
   candidate but does not turn every field into a proven fact. Identity links,
   claims and relationship evidence remain separate.

## Data flow

```text
user message
    |
    +--> conversation artifact (stable message id, local only)
    |
    +--> tree tools ---------------------------> familiar tree + undo
    |       |
    |       +--> person candidates + atomic claims (“со слов” / hypothesis)
    |
    +--> source tool
            |
            +--> search attempt (query, filters, scope, result/blocker)
            +--> fetched artifact (URL, record id, access time, provenance)
            +--> field claims (one proposition per source field)
            +--> unmerged candidate identity

evidence audit --> broken references, invalid statuses, false corroboration,
                   privacy and coverage warnings
```

## Canonical boundaries

- `tree.json` remains the UI projection and its undo history.
- `research-case.json` is the append-oriented evidence case.
- A research person may point to a tree person, but source candidates do not
  receive that link automatically.
- Artifacts preserve raw source fields; claims preserve interpretation.
- Claim status and artifact provenance are separate concepts.
- Код выводит `independenceGroup` из устойчивого архивного шифра, внешнего ID
  или хеша. Ручная подсказка модели не считается доверенной; материалы без
  проверяемой цепочки происхождения остаются в общей unverified-группе.
- Contradictions coexist and are never resolved by overwriting old claims.
- A `corroborated` status requires two declared independent groups and a
  rationale, but the audit never labels a claim “true”.

## Instruction routing

Always loaded:

- artifacts are not facts;
- namesakes remain separate;
- copies are not independent evidence;
- preserve source spelling and contradictions;
- incomplete search is not negative evidence;
- living-person privacy and CAPTCHA rules.

Loaded by deterministic topic match:

- search and archives: `source-strategy.md`;
- historical places, calendars and scripts: `ex-ussr-locale-guide.md`;
- scans, military, repression and exhausted sources: `field-lessons.md`;
- login, browser errors and CAPTCHA: `browser-and-captcha.md`;
- living people, DNA and sensitive findings: `privacy-and-safety.md`;
- evaluation of evidence and identities: `evidence-protocol.md`.

The model never receives `seed-sources.md` unless it is choosing a new source.
Every time-sensitive procedure still requires a current official check.

## Failure modes and controls

| Failure | Control | Verification |
| --- | --- | --- |
| Existing `tree.json` becomes unreadable | research state is separate; tree format unchanged | legacy fixture test |
| Duplicate retries create duplicate artifacts | stable external/message keys and idempotent upsert | retry tests |
| Two mirrors count as corroboration | explicit independence groups and audit warning | copied-index test |
| Empty results are reported as absence | search result status records scope and completeness | negative-search test |
| Coordinated tree/evidence write fails halfway | both local JSON snapshots roll back together before the error is surfaced | cross-file rollback test |
| One source overwrites a conflicting fact | claims are append-only and separately addressable | conflicting-date test |
| Namesakes merge through a tree update | candidates remain unlinked until an explicit identity action | namesake test |
| Sensitive live-person data leaks to search/report | 1930 cutoff, private-by-default unknown status, bounded schemas and redacted report | living-person eval and report tests |
| Full skill bloats every model request | deterministic topic router and size-bounded modules | router tests |

## Test coverage map

```text
CODE PATHS                                      RESEARCH BEHAVIOR
case store                                      identity
  +-- empty initialization                        +-- namesakes stay separate
  +-- atomic write                                +-- explicit link only
  +-- idempotent message capture                  +-- grandparent = two edges
  +-- legacy tree bridge

search instrumentation                           evidence
  +-- success -> search + artifact                +-- direct record = single-source
  +-- empty -> incomplete/not-found scope         +-- copied indexes = one group
  +-- CAPTCHA -> blocked attempt                  +-- conflicting dates coexist
  +-- fetch -> raw fields + claims                +-- audit never declares truth

instruction router                               safety
  +-- core always loaded                          +-- living-person minimization
  +-- locale/search/field modules                 +-- CAPTCHA hand-off
  +-- unrelated modules omitted                   +-- no result != no person
```

Unit tests cover stores, audit, routing and source instrumentation. Agent evals
exercise tool choice and prohibited conclusions with synthetic people only.
`npm test` runs executable invariants; `npm run build` remains the type and
frontend build gate.

## Implementation order

1. Vendor and pin upstream.
2. Add evidence types, case store, audit and migration bridge.
3. Instrument user messages and tree tools.
4. Instrument ОБД search and record reading.
5. Add evidence tools and research context to the agent.
6. Add modular skill instruction routing.
7. Add executable unit tests and agent eval fixtures.
8. Update product documentation and run completion audit.

Итоговая сверка реализации с требованиями: [evidence-engine-audit.md](evidence-engine-audit.md).

## Not in scope

- Replacing React, AI SDK or the visual design.
- Automatically merging an external record into the family tree.
- Sending archive requests or contacting people.
- Adding authentication or multi-family tenancy in this change.
- Implementing every source from the seed catalog before the evidence pipeline
  has passed the same contract with ОБД.
- Releasing, versioning, publishing or creating a pull request.
