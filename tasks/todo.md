# Structured SAGIP Figures Task List

## Task 1: JSON figure model and generator
**Acceptance criteria:**
- [ ] Figure specs exist as JSON.
- [ ] A deterministic generator produces SVG assets without third-party packages.
- [ ] Invalid/missing required figure data causes a clear failure.

**Verification:**
- [ ] Parse all JSON specs.
- [ ] Generate all SVG files.
- [ ] Validate SVG XML.

## Task 2: Architecture and ERD figures
**Acceptance criteria:**
- [ ] Figure 1 shows local durability before transport and distinguishes relay/server/responder states.
- [ ] Figure 2A shows the current on-device data model with selected PK/FK attributes and cardinalities.
- [ ] Figure 2B shows the current backend PostgreSQL data model separately.

**Verification:**
- [ ] Compare entities/attributes to current SQLite/PostgreSQL schema sources.
- [ ] Inspect generated SVGs visually.

## Task 3: Process, timeline, and field sequence
**Acceptance criteria:**
- [ ] Figure 3 uses explicit evidence-state terminology.
- [ ] Figure 4 uses readable continuous timeline bars.
- [ ] Figure 5 shows the complete two-phone store-carry-forward and responder-ACK return sequence.
- [ ] No figure claims field acceptance unless the canonical runbook evidence supports it.

**Verification:**
- [ ] Compare with PROJECT_STATUS.md, PROGRESS_LOG.md, DELIVERY_PIPELINE.md, and PHYSICAL_TESTING_RUNBOOK.md.
- [ ] Inspect generated SVGs visually.

## Task 4: DOCX integration and visual QA
**Acceptance criteria:**
- [ ] A separate improved-figures DOCX is produced without overwriting the active final draft.
- [ ] Figure captions and list-of-figures entries are consistent.
- [ ] Final page rendering is readable and clean.

**Verification:**
- [ ] Office/OpenXML validation passes.
- [ ] Render every page and inspect for clipping, overlap, missing glyphs, and unreadable figures.
