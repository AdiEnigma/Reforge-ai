#!/usr/bin/env python
"""
run_evaluation.py — Dimension-accuracy harness for ReForge AI.

Compares predicted component dimensions against caliper-measured ground truth
and reports per-dimension MAE / MAPE and tolerance pass rates.

Dataset schema (JSON array, one object per part)::

    {
      "id": "part-001",
      "component_type": "gear",
      "predictions": {"outerDiameter": 60.2, "teeth": 24, "module": 2.5},
      "ground_truth": {
        "outerDiameter": {"value": 60.0, "tolerance": 0.1},
        "teeth": {"value": 24},
        "module": {"value": 2.5, "tolerance": 0.02}
      }
    }

``predictions`` may also be nested under ``analysis.dimensions`` - both are
accepted. Missing predictions count as errors; extra predictions are ignored.

Usage::

    python evaluation/run_evaluation.py evaluation/dataset.json
    python evaluation/run_evaluation.py dataset.json --json report.json --md report.md
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class DimensionStat:
    key: str
    count: int = 0
    abs_errors: List[float] = field(default_factory=list)
    rel_errors: List[float] = field(default_factory=list)
    within_tolerance: int = 0
    tolerance_checked: int = 0
    missing: int = 0

    def add(self, predicted: Optional[float], truth: float, tolerance: Optional[float]) -> None:
        self.count += 1
        if predicted is None or not math.isfinite(predicted):
            self.missing += 1
            self.abs_errors.append(float("nan"))
            self.rel_errors.append(float("nan"))
            return
        error = abs(predicted - truth)
        self.abs_errors.append(error)
        self.rel_errors.append(error / abs(truth) if truth else float("nan"))
        if tolerance is not None:
            self.tolerance_checked += 1
            if error <= tolerance:
                self.within_tolerance += 1

    def summary(self) -> Dict[str, Any]:
        valid = [value for value in self.abs_errors if not math.isnan(value)]
        rel = [value for value in self.rel_errors if not math.isnan(value)]
        mae = sum(valid) / len(valid) if valid else None
        mape = (sum(rel) / len(rel) * 100.0) if rel else None
        return {
            "count": self.count,
            "missing": self.missing,
            "mae": _round(mae),
            "mape_percent": _round(mape),
            "tolerance_checked": self.tolerance_checked,
            "within_tolerance": self.within_tolerance,
            "tolerance_pass_rate": _round(
                self.within_tolerance / self.tolerance_checked
                if self.tolerance_checked
                else None
            ),
        }


def _round(value: Optional[float], digits: int = 4) -> Optional[float]:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _predictions(entry: Dict[str, Any]) -> Dict[str, Any]:
    direct = entry.get("predictions")
    if isinstance(direct, dict):
        return direct
    analysis = entry.get("analysis")
    if isinstance(analysis, dict):
        dimensions = analysis.get("dimensions")
        if isinstance(dimensions, dict):
            return dimensions
    return {}


def _truth(entry: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    truth = entry.get("ground_truth")
    if not isinstance(truth, dict):
        return {}
    normalized: Dict[str, Dict[str, Any]] = {}
    for key, value in truth.items():
        if isinstance(value, dict):
            normalized[key] = value
        elif isinstance(value, (int, float)):
            normalized[key] = {"value": value}
    return normalized


def evaluate(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    stats: Dict[str, DimensionStat] = {}
    missing_truth = 0
    parts: List[Dict[str, Any]] = []

    for entry in entries:
        part_id = str(entry.get("id") or f"part-{len(parts) + 1}")
        truth = _truth(entry)
        predictions = _predictions(entry)
        if not truth:
            missing_truth += 1
            continue

        part_errors: Dict[str, Any] = {}
        for key, spec in truth.items():
            try:
                expected = float(spec["value"])
            except (KeyError, TypeError, ValueError):
                continue
            tolerance = spec.get("tolerance")
            try:
                tolerance = float(tolerance) if tolerance is not None else None
            except (TypeError, ValueError):
                tolerance = None
            try:
                predicted = float(predictions.get(key))
            except (TypeError, ValueError):
                predicted = None
            stat = stats.setdefault(key, DimensionStat(key))
            stat.add(predicted, expected, tolerance)
            if predicted is not None:
                part_errors[key] = {
                    "predicted": _round(predicted),
                    "expected": _round(expected),
                    "abs_error": _round(abs(predicted - expected)),
                }
            else:
                part_errors[key] = {
                    "predicted": None,
                    "expected": _round(expected),
                    "abs_error": None,
                }
        parts.append(
            {
                "id": part_id,
                "component_type": entry.get("component_type"),
                "dimensions": part_errors,
            }
        )

    dimension_summaries = {key: stat.summary() for key, stat in sorted(stats.items())}
    all_mae = [
        summary["mae"]
        for summary in dimension_summaries.values()
        if summary["mae"] is not None
    ]
    all_mape = [
        summary["mape_percent"]
        for summary in dimension_summaries.values()
        if summary["mape_percent"] is not None
    ]

    return {
        "parts_evaluated": len(parts),
        "parts_missing_ground_truth": missing_truth,
        "dimensions": dimension_summaries,
        "overall": {
            "mean_dimension_mae": _round(sum(all_mae) / len(all_mae) if all_mae else None),
            "mean_dimension_mape_percent": _round(
                sum(all_mape) / len(all_mape) if all_mape else None
            ),
        },
        "part_results": parts,
    }


def render_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# ReForge AI dimension-accuracy report",
        "",
        f"- Parts evaluated: {report['parts_evaluated']}",
        f"- Parts missing ground truth: {report['parts_missing_ground_truth']}",
        "",
        "| Dimension | Parts | Missing | MAE | MAPE % | Within tolerance | Pass rate |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for key, summary in report["dimensions"].items():
        lines.append(
            "| {key} | {count} | {missing} | {mae} | {mape} | {within}/{checked} | {rate} |".format(
                key=key,
                count=summary["count"],
                missing=summary["missing"],
                mae=_fmt(summary["mae"]),
                mape=_fmt(summary["mape_percent"]),
                within=summary["within_tolerance"],
                checked=summary["tolerance_checked"],
                rate=_fmt_percent(summary["tolerance_pass_rate"]),
            )
        )
    lines.extend(
        [
            "",
            "Overall mean dimension MAE: {mae}".format(
                mae=_fmt(report["overall"]["mean_dimension_mae"])
            ),
            "Overall mean dimension MAPE: {mape} %".format(
                mape=_fmt(report["overall"]["mean_dimension_mape_percent"])
            ),
            "",
        ]
    )
    return "\n".join(lines)


def _fmt(value: Optional[float]) -> str:
    return "-" if value is None else f"{value:.3f}"


def _fmt_percent(value: Optional[float]) -> str:
    return "-" if value is None else f"{value * 100:.0f}%"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate ReForge AI dimension accuracy.")
    parser.add_argument("dataset", help="Path to the evaluation dataset JSON file.")
    parser.add_argument("--json", dest="json_out", help="Write the full report as JSON.")
    parser.add_argument("--md", dest="md_out", help="Write a Markdown summary.")
    args = parser.parse_args(argv)

    with open(args.dataset, "r", encoding="utf-8") as handle:
        dataset = json.load(handle)
    if not isinstance(dataset, list):
        print("Dataset must be a JSON array of part entries.", file=sys.stderr)
        return 2

    report = evaluate(dataset)
    print(json.dumps(report, indent=2))
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
    if args.md_out:
        with open(args.md_out, "w", encoding="utf-8") as handle:
            handle.write(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
