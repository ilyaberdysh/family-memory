# Design System — Family Memory

## Product model

Family Memory has two primary modes:

1. **Research** — a conversation-first family researcher. The user starts with a person, surname, place, photograph, or unanswered question. The assistant gathers context, distinguishes facts from hypotheses, cites sources, and proposes changes. A person must explicitly accept proposals before they reach the tree.
2. **Family album** — a shared, private collection of photographs, voices, video, and stories. It should feel like opening a carefully assembled family book, not managing files.

The family tree is an important result of research, but not the product's front door. It remains manually editable and independently usable when AI is unavailable.

## Memorable quality

The product should feel like sitting at a table with a family album and a thoughtful researcher: intimate, curious, trustworthy, and alive.

## Aesthetic direction

- **Direction:** contemporary editorial archive
- **Decoration:** intentional and quiet; typography, photographs, paper-like surfaces, and a small amount of ink-red color carry the identity
- **Mood:** warm without faux nostalgia; capable without looking like enterprise software
- **Avoid:** dashboard-card grids, blue SaaS chrome, decorative gradients, uniform bubbly corners, stock imagery, and claims that research occurred when no source was actually checked

## Typography

- **Display:** `Iowan Old Style`, `Palatino Linotype`, `Book Antiqua`, `Georgia`, serif
- **Body and UI:** `Avenir Next`, `Avenir`, `Segoe UI`, sans-serif
- **Data:** body family with tabular numerals enabled where dates or counts align
- **Scale:** 11, 13, 15, 17, 22, 31, 38, 48 px
- **Loading:** local system fonts only. Private family pages must not contact a font CDN.

## Color

- **Research ink:** `#1D5B4D`
- **Deep ink:** `#183C34`
- **Warm paper:** `#F7F3EB`
- **Canvas:** `#F2EEE5`
- **Album surface:** `#FFFDF8`
- **Source red:** `#D87352`
- **Text:** `#1D2A25`
- **Muted text:** `#766F65`
- **Rule:** `#E4DDD0`
- **Semantic colors:** success `#2E755B`, warning `#A56B22`, error `#A84336`, info `#315F89`

Color is restrained. Green marks research and trusted actions. Red marks the human spark: starting, recording, and noteworthy source material. Semantic error colors never masquerade as decoration.

## Spacing and shape

- **Base unit:** 4 px
- **Scale:** 4, 8, 12, 16, 20, 24, 32, 48, 64 px
- **Density:** spacious on research and album surfaces; compact only in tree controls and review workflows
- **Radius:** 8 px for album objects, 12 px for controls, 16 px for conversation inputs, full circle for avatars and the primary send action
- **Shadow:** rare and diffuse; borders and surface contrast do most of the work

## Layout

- Desktop uses a dark persistent rail and one generous content plane.
- Research centers the prompt and conversation at a readable width. Prior conversations form a secondary rail.
- The album uses an editorial grid with large visual covers and typographic story cards.
- The tree uses the full canvas, but is reached from research rather than treated as the home page.
- Mobile has three destinations: **Исследовать**, **Альбом**, **Древо**. Family and participant controls live in the header.

## Motion

- **Approach:** minimal and physical
- **Micro interactions:** 100–160 ms
- **Surface transitions:** 180–240 ms
- Cards may lift by 1–3 px. Conversation content should not animate in a way that competes with reading.
- Respect `prefers-reduced-motion` everywhere.

## Trust rules for the interface

- Never present an assistant inference as a discovered fact.
- A sourced claim shows the source and what was actually read.
- Research proposals remain proposals until a participant accepts them; confirmation still requires another participant.
- Archive material can stand alone without extraction into structured facts.
- Failed research and unavailable AI are shown honestly; manual editing and saving remain usable.

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-10-13 | Make research the default route | The product starts with curiosity, not data administration. |
| 2026-10-13 | Promote the archive to “Семейный альбом” | Users understand the emotional object before they understand the storage model. |
| 2026-10-13 | Keep the tree as a first-class result | It remains essential, but grows from conversations, sources, and explicit decisions. |
| 2026-10-13 | Use local fonts only | Private pages should not leak visits or metadata to font CDNs. |
