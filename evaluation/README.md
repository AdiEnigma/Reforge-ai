# Evaluation harness

Measure ReForge AI dimension accuracy against physical, caliper-measured parts.
This is the source of truth for the plan's "50 to 100 real parts" evaluation
set; the committed dataset is an example only.

## Dataset format

`dataset.json` is a JSON array. Each entry:

```json
{
  "id": "part-001",
  "component_type": "gear",
  "predictions": { "outerDiameter": 60.2, "teeth": 24 },
  "ground_truth": {
    "outerDiameter": { "value": 60.0, "tolerance": 0.1 },
    "teeth": { "value": 24 }
  }
}
```

- `predictions` may instead be nested at `analysis.dimensions`.
- `ground_truth[*].tolerance` is optional. When present, the harness reports a
  tolerance pass rate per dimension.
- Missing predictions count as errors (and as `missing` in the report).
- Use the same dimension keys as the app (`outerDiameter`, `innerDiameter`,
  `height`, `length`, `thickness`, `width`, `teeth`, `module`, `helixAngle`).

## Measurement protocol

1. Capture 1 primary photo plus 2-3 overlapping orthogonal views per part.
2. Record user-supplied reference dimensions exactly as entered in the app
   (this is also the anchor used for scaling).
3. Measure each dimension three times with digital calipers and record the mean
   in `ground_truth`.
4. Set tolerances from the caliper resolution (typically 0.02-0.05 mm for
   small features, 0.1-0.5 mm for large envelopes).
5. Run the harness with the app's predicted dimensions, never with edited ones.

## Run

```powershell
..\.venv\Scripts\python.exe -B evaluation\run_evaluation.py evaluation\dataset.example.json --md evaluation\report.md
```

Outputs per-dimension MAE, MAPE, tolerance pass rate, overall means, and
per-part errors. `--json` writes the full machine-readable report.

## Test the harness

```powershell
..\.venv\Scripts\python.exe -B -m pytest evaluation -q
```
