# Implementation Plan: Structured SAGIP Documentation Figures

## Overview
Replace the current hand-authored figure assets with a small JSON-driven figure system. Use current SAGIP source, tests, and canonical specifications as the factual basis. Generate readable SVG assets for the documentation and add a field-acceptance sequence figure. Do not change runtime behavior.

## Architecture Decisions
- JSON is the semantic source of truth for figure content.
- SVG is the generated presentation format because it remains sharp in DOCX/PDF output.
- Figure specifications describe nodes, entities, attributes, relationships, evidence states, tasks, and protocol flows. They do not encode most pixel coordinates.
- The generator uses the Python standard library only.
- ERD content is split into on-device and backend views to keep final-page text readable.
- Operational-security and field-validation claims use explicit evidence labels and do not imply production readiness.

## Task List

### Phase 1: Foundation
- [ ] Task 1: Add JSON figure specifications and deterministic SVG generator.
- [ ] Task 2: Generate Figure 1 and Figure 2A/2B from current implementation evidence.

### Checkpoint: Foundation
- [ ] JSON parses successfully.
- [ ] Generated SVGs are valid XML and readable at document scale.

### Phase 2: Process and Field Evidence
- [ ] Task 3: Generate Figure 3, Figure 4, and Figure 5 from current status and field-test evidence.

### Checkpoint: Figure Set
- [ ] All figures use consistent typography, spacing, status vocabulary, and captions.
- [ ] No figure overstates physical-device or production evidence.

### Phase 3: Document Integration
- [ ] Task 4: Create a new documentation DOCX copy using the improved figures and verify it visually.

### Checkpoint: Complete
- [ ] DOCX validates.
- [ ] Every page renders without clipping, overlap, or unreadable figure text.
- [ ] Repository diff contains only documentation/figure work.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| ERD becomes too dense | High | Split on-device and backend ERDs and show only documentation-relevant attributes. |
| Figure claims drift from implementation | High | Ground each semantic object in source/spec/test evidence before generation. |
| Concurrent edits to the current final DOCX | High | Do not overwrite the current active document. Create a separate improved-figures copy. |
| SVG renders differently in Word | Medium | Produce PNG fallbacks for document insertion if Office/Word SVG handling is inconsistent. |
| Status colors imply stronger evidence than exists | High | Always print evidence labels in text and use color only as a secondary cue. |

## Open Questions
None required for the first implementation pass.