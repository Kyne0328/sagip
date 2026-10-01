# SAGIP Documentation Figures

The figure files in this directory are generated from semantic JSON specifications.

## Source and output

- JSON specifications: `artifacts/figures/specs/*.json`
- Generator: `scripts/generate_documentation_figures.py`
- SVG outputs: paths declared by each specification

Run:

```powershell
py scripts/generate_documentation_figures.py --check
py scripts/generate_documentation_figures.py
```

The JSON is the editable figure source. It describes entities, selected attributes, evidence states, logical grid placement, protocol flows, and timeline data. The generator owns exact SVG coordinates and typography.

## Evidence rules

Figure content must follow SAGIP evidence priority:

1. current source code
2. current automated/device tests
3. current runtime/deployment evidence
4. current specifications
5. project status/progress documents

Do not use a figure to convert automated verification into physical field validation. The complete two-phone store-carry-forward and return-acknowledgement path remains a distinct field-acceptance claim.

The active normal envelope-preparation path must be shown as SGP1 unless current source changes. SGP2/HPKE support can be shown only as implemented/tested capability, not as the normal operational path, while `EnvelopePreparationService` continues to produce SGP1.
