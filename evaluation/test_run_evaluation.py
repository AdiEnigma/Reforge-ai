"""Tests for the dimension-accuracy evaluation harness."""

from __future__ import annotations

import json
import math

import pytest

from run_evaluation import evaluate, render_markdown, main


def _entry(**overrides):
    base = {
        "id": "p1",
        "component_type": "gear",
        "predictions": {"outerDiameter": 60.2, "teeth": 24},
        "ground_truth": {
            "outerDiameter": {"value": 60.0, "tolerance": 0.1},
            "teeth": {"value": 24},
        },
    }
    base.update(overrides)
    return base


def test_evaluate_computes_mae_and_tolerance_pass_rate():
    report = evaluate([_entry()])
    assert report["parts_evaluated"] == 1
    outer = report["dimensions"]["outerDiameter"]
    assert outer["count"] == 1
    assert outer["mae"] == pytest.approx(0.2)
    assert outer["tolerance_checked"] == 1
    assert outer["within_tolerance"] == 0
    assert outer["tolerance_pass_rate"] == 0.0
    assert outer["mape_percent"] == pytest.approx(0.3333, abs=1e-3)
    assert report["dimensions"]["teeth"]["mae"] == 0.0


def test_evaluate_accepts_nested_analysis_dimensions():
    entry = {
        "id": "p2",
        "analysis": {"dimensions": {"length": 80.5}},
        "ground_truth": {"length": {"value": 80.0, "tolerance": 1.0}},
    }
    report = evaluate([entry])
    assert report["dimensions"]["length"]["mae"] == pytest.approx(0.5)
    assert report["dimensions"]["length"]["within_tolerance"] == 1


def test_evaluate_counts_missing_predictions_and_ground_truth():
    entry = _entry(predictions={"outerDiameter": 60.0})
    report = evaluate([entry, {"id": "no-truth"}])
    assert report["parts_evaluated"] == 1
    assert report["parts_missing_ground_truth"] == 1
    assert report["dimensions"]["teeth"]["missing"] == 1
    assert report["dimensions"]["outerDiameter"]["mae"] == 0.0


def test_render_markdown_contains_dimension_rows():
    markdown = render_markdown(evaluate([_entry()]))
    assert "| outerDiameter |" in markdown
    assert "| teeth |" in markdown
    assert "Overall mean dimension MAE" in markdown


def test_cli_writes_json_and_markdown(tmp_path):
    dataset = tmp_path / "dataset.json"
    out_json = tmp_path / "report.json"
    out_md = tmp_path / "report.md"
    dataset.write_text(json.dumps([_entry()]), encoding="utf-8")

    assert main([str(dataset), "--json", str(out_json), "--md", str(out_md)]) == 0
    report = json.loads(out_json.read_text(encoding="utf-8"))
    assert report["parts_evaluated"] == 1
    assert "dimension-accuracy" in out_md.read_text(encoding="utf-8")


def test_evaluate_handles_non_finite_predictions():
    entry = _entry(predictions={"outerDiameter": float("nan"), "teeth": 24})
    report = evaluate([entry])
    assert report["dimensions"]["outerDiameter"]["missing"] == 1
    assert report["dimensions"]["outerDiameter"]["mae"] is None
