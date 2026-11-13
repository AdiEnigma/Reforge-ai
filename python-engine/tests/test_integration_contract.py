"""
test_integration_contract.py — Tests for the Reconstruction→CAD interface.

Covers the stable ``reforge-cad-interface`` v1.0 contract: the worked example,
round-tripping back to the same feature recipe, and rejection of incomplete or
unreliable inputs with explicit diagnostics.
"""

from __future__ import annotations

import copy
import json
import os

import pytest

from cad import integration_contract as ic
from cad.specimens.advanced_housing import build_advanced_housing_recipe


def _example():
    return copy.deepcopy(ic.example_housing_interface())


# ---------------------------------------------------------------------------
# Minimal JSON Schema (Draft 2020-12 subset) validator
# ---------------------------------------------------------------------------
#
# The project deliberately ships no third-party JSON Schema validator, so these
# tests exercise the *published* schema with a tiny evaluator that supports
# exactly the keywords ``interface_json_schema()`` emits.  This keeps the schema
# under test without adding a dependency.

def _type_ok(value, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    if expected == "integer":
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return True
        return isinstance(value, float) and value.is_integer()
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _schema_errors(schema, instance, path: str = "$"):
    """Return a list of human-readable errors, empty when ``instance`` is valid."""
    errors = []
    if not isinstance(schema, dict):
        return errors

    expected = schema.get("type")
    if expected is not None:
        options = expected if isinstance(expected, list) else [expected]
        if not any(_type_ok(instance, opt) for opt in options):
            errors.append(f"{path}: expected type {expected!r}")
            return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of the allowed values")

    if isinstance(instance, str) and "minLength" in schema:
        if len(instance) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: above maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: not greater than {schema['exclusiveMinimum']}")

    if isinstance(instance, dict):
        for required in schema.get("required", []):
            if required not in instance:
                errors.append(f"{path}: missing required property {required!r}")
        properties = schema.get("properties", {})
        for key, subschema in properties.items():
            if key in instance:
                errors.extend(_schema_errors(subschema, instance[key],
                                             f"{path}.{key}"))
        extra = schema.get("additionalProperties", True)
        if extra is False:
            for key in instance:
                if key not in properties:
                    errors.append(f"{path}: unexpected property {key!r}")
        elif isinstance(extra, dict):
            for key in instance:
                if key not in properties:
                    errors.extend(_schema_errors(extra, instance[key],
                                                 f"{path}.{key}"))

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: more than maxItems {schema['maxItems']}")
        if "items" in schema:
            for i, item in enumerate(instance):
                errors.extend(_schema_errors(schema["items"], item, f"{path}[{i}]"))

    for subschema in schema.get("allOf", []):
        errors.extend(_schema_errors(subschema, instance, path))

    if "if" in schema:
        if not _schema_errors(schema["if"], instance, path):
            errors.extend(_schema_errors(schema.get("then", {}), instance, path))
        else:
            errors.extend(_schema_errors(schema.get("else", {}), instance, path))

    return errors


def _schema_validate(doc) -> list:
    """Validate a full interface document against the published schema."""
    return _schema_errors(ic.interface_json_schema(), doc)


# ---------------------------------------------------------------------------
# Happy path / round-trip
# ---------------------------------------------------------------------------

def test_example_interface_is_valid():
    res = ic.validate_interface(_example())
    assert res["valid"], res["issues"]
    assert res["status"] == "ok"
    assert res["recipe"] is not None
    assert res["recipe_dict"]["features"]


def test_example_round_trips_to_same_features():
    doc = _example()
    res = ic.validate_interface(doc)
    built = res["recipe_dict"]
    original = build_advanced_housing_recipe()

    assert len(built["features"]) == len(original["features"])
    for a, b in zip(original["features"], built["features"]):
        assert a["id"] == b["id"]
        assert a["type"] == b["type"]
        for key, val in a["parameters"].items():
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                assert b["parameters"][key] == pytest.approx(float(val), abs=1e-9)


def test_interface_from_recipe_round_trip_small():
    recipe = {
        "format": "reforge-feature-recipe", "version": "1.0",
        "name": "small", "units": "mm",
        "features": [
            {"id": "f1", "type": "base_cylinder",
             "parameters": {"radius": 10.0, "zStart": 0.0, "zEnd": 20.0}},
        ],
        "expected": {}, "metadata": {},
    }
    doc = ic.interface_from_recipe(recipe, provenance="measured", uncertainty=0.02)
    assert doc["dimensions"]["f1__radius"]["value"] == 10.0
    res = ic.validate_interface(doc)
    assert res["valid"], res["issues"]
    params = res["recipe_dict"]["features"][0]["parameters"]
    assert params["radius"] == pytest.approx(10.0)
    assert params["zEnd"] == pytest.approx(20.0)


# ---------------------------------------------------------------------------
# Rejections — incomplete / unreliable inputs
# ---------------------------------------------------------------------------

def test_missing_dimension_is_rejected():
    doc = _example()
    doc["dimensions"].pop("body__radius")
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("body__radius" in i for i in res["issues"])


def test_unknown_scale_is_rejected():
    doc = _example()
    doc["units"]["scale_status"] = "unknown"
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("scale" in i.lower() for i in res["issues"])


def test_non_metric_units_rejected():
    doc = _example()
    doc["units"]["length"] = "inch"
    res = ic.validate_interface(doc)
    assert not res["valid"]


def test_scaled_units_apply_scale_factor():
    doc = _example()
    doc["units"]["scale_status"] = "scaled"
    doc["units"]["scale_factor"] = 2.0
    res = ic.validate_interface(doc)
    assert res["valid"], res["issues"]
    # The first feature's first numeric parameter should have doubled.
    params = res["recipe_dict"]["features"][0]["parameters"]
    original = build_advanced_housing_recipe()["features"][0]["parameters"]
    for key, val in original.items():
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            assert params[key] == pytest.approx(float(val) * 2.0, rel=1e-6)


def test_assumed_dimension_rejected_by_default():
    doc = _example()
    doc["dimensions"]["body__radius"]["provenance"] = "assumed"
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("assumed" in i.lower() for i in res["issues"])


def test_assumed_dimension_accepted_with_opt_in():
    doc = _example()
    doc["dimensions"]["body__radius"]["provenance"] = "assumed"
    res = ic.validate_interface(doc, allow_assumed=True)
    assert res["valid"], res["issues"]


def test_low_confidence_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"]["confidence"] = 0.1
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("confidence" in i.lower() for i in res["issues"])


def test_high_uncertainty_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"]["uncertainty"] = 40.0  # vs value 45
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("uncertainty" in i.lower() for i in res["issues"])


def test_missing_provenance_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"].pop("provenance")
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("provenance" in i.lower() for i in res["issues"])


def test_bare_number_dimension_rejected_when_referenced():
    doc = _example()
    doc["dimensions"]["body__radius"] = 45.0  # no provenance
    res = ic.validate_interface(doc)
    assert not res["valid"]


# ---------------------------------------------------------------------------
# v1.0 structural requirements: operation + dimension value/unit/provenance
# ---------------------------------------------------------------------------

def test_missing_operation_rejected():
    doc = _example()
    doc["features"][0].pop("operation")
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("operation" in i.lower() for i in res["issues"])


def test_blank_operation_rejected():
    doc = _example()
    doc["features"][0]["operation"] = ""
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("operation" in i.lower() for i in res["issues"])


def test_operation_inconsistent_with_type_rejected():
    doc = _example()
    doc["features"][0]["operation"] = "subtractive"  # flange is additive
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("operation" in i.lower() for i in res["issues"])


def test_missing_unit_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"].pop("unit")
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("unit" in i.lower() for i in res["issues"])


def test_unknown_unit_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"]["unit"] = "furlong"
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("unit" in i.lower() for i in res["issues"])


def test_non_metric_length_unit_rejected():
    doc = _example()
    doc["dimensions"]["body__radius"]["unit"] = "inch"
    res = ic.validate_interface(doc)
    assert not res["valid"]


def test_fractional_count_rejected():
    doc = _example()
    doc["dimensions"]["mounting_holes__count"]["value"] = 6.5
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("count" in i.lower() for i in res["issues"])


def test_incorrect_angle_unit_rejected():
    doc = _example()
    doc["dimensions"]["rib_1__angleDeg"]["unit"] = "mm"
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any(("angle" in i.lower()) or ("unit" in i.lower())
               for i in res["issues"])


def test_unreferenced_dimension_still_needs_unit_and_provenance():
    doc = _example()
    doc["dimensions"]["spare_dim"] = 12.0  # bare number, not referenced
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("spare_dim" in i for i in res["issues"])


def test_schema_requires_operation_and_full_dimension_fields():
    schema = ic.interface_json_schema()
    feature = schema["properties"]["features"]["items"]
    assert "operation" in feature["required"]
    dim = schema["properties"]["dimensions"]["additionalProperties"]
    assert {"value", "unit", "provenance"} <= set(dim["required"])
    # Dimensions are objects only — bare numbers are no longer allowed.
    assert dim.get("type") == "object"
    assert "oneOf" not in dim


# ---------------------------------------------------------------------------
# Count units: integer values, explicit dimensionless units, no empty string
# ---------------------------------------------------------------------------

def _count_dim(doc):
    return doc["dimensions"]["mounting_holes__count"]


def test_count_unit_aliases_are_explicit_and_exclude_empty_string():
    # The empty string must not ambiguously stand for both count and
    # dimensionless; both classes use their explicit spellings only.
    assert "" not in ic._SEMANTIC_UNIT_ALIASES[ic.SEMANTIC_COUNT]
    assert "" not in ic._SEMANTIC_UNIT_ALIASES[ic.SEMANTIC_DIMENSIONLESS]
    assert ic._SEMANTIC_UNIT_ALIASES[ic.SEMANTIC_COUNT] == {
        "count", "counts", "integer", "pcs", "pieces"}
    assert ic._SEMANTIC_UNIT_ALIASES[ic.SEMANTIC_DIMENSIONLESS] == {
        "dimensionless", "none", "ratio", "1"}


def test_json_schema_forces_integer_value_for_count_units():
    schema = ic.interface_json_schema()
    dim = schema["properties"]["dimensions"]["additionalProperties"]
    # The empty string is gone from the published unit vocabulary too.
    assert "" not in dim["properties"]["unit"]["enum"]
    # A conditional (not oneOf) branch requires an integer value for counts.
    branches = dim.get("allOf")
    assert branches, "count-integer constraint missing from the schema"
    branch = branches[0]
    assert set(branch["if"]["properties"]["unit"]["enum"]) == {
        "count", "counts", "integer", "pcs", "pieces"}
    assert branch["then"]["properties"]["value"]["type"] == "integer"


def test_json_schema_accepts_integer_count():
    doc = _example()
    _count_dim(doc)["value"] = 6
    assert _schema_validate(doc) == []
    # And the runtime agrees.
    assert ic.validate_interface(doc)["valid"]


def test_json_schema_rejects_fractional_count():
    doc = _example()
    _count_dim(doc)["value"] = 6.5
    errors = _schema_validate(doc)
    assert errors, "JSON Schema accepted a fractional count"
    assert any("mounting_holes__count" in e for e in errors)


def test_runtime_rejects_fractional_count():
    doc = _example()
    _count_dim(doc)["value"] = 6.5
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("count" in i.lower() and "integer" in i.lower()
               for i in res["issues"])


def test_empty_unit_not_accepted_for_count():
    doc = _example()
    _count_dim(doc)["unit"] = ""
    # Rejected by the published schema ...
    assert _schema_validate(doc), "JSON Schema accepted an empty count unit"
    # ... and by runtime validation.
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("unit" in i.lower() for i in res["issues"])


def test_existing_valid_housing_interface_remains_valid():
    doc = _example()
    # Runtime accepts the reference document ...
    res = ic.validate_interface(doc)
    assert res["valid"], res["issues"]
    # ... and it satisfies the published JSON Schema.
    assert _schema_validate(doc) == []


def test_bad_format_rejected():
    doc = _example()
    doc["format"] = "something-else"
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("format" in i.lower() for i in res["issues"])


def test_empty_features_rejected():
    doc = _example()
    doc["features"] = []
    res = ic.validate_interface(doc)
    assert not res["valid"]


def test_missing_component_field_rejected():
    doc = _example()
    doc["component"].pop("geometry_style")
    res = ic.validate_interface(doc)
    assert not res["valid"]


def test_unknown_feature_type_rejected_by_recipe_validator():
    doc = _example()
    doc["features"].append({"id": "bad", "type": "not_a_feature", "parameters": {}})
    res = ic.validate_interface(doc)
    assert not res["valid"]
    assert any("not_a_feature" in i for i in res["issues"])


def test_non_dict_input_rejected():
    res = ic.validate_interface(["not", "a", "dict"])
    assert not res["valid"]
    assert res["issues"]


# ---------------------------------------------------------------------------
# Schema + serialisability
# ---------------------------------------------------------------------------

def test_json_schema_is_well_formed():
    schema = ic.interface_json_schema()
    assert schema["$schema"].startswith("https://json-schema.org")
    assert schema["properties"]["format"]["const"] == ic.INTERFACE_FORMAT
    assert set(schema["required"]) >= {"format", "component", "units",
                                       "dimensions", "features"}


def test_example_is_json_serialisable():
    text = json.dumps(_example())
    doc = json.loads(text)
    assert ic.validate_interface(doc)["valid"]


# ---------------------------------------------------------------------------
# Versioned API endpoint
# ---------------------------------------------------------------------------

def _small_interface():
    recipe = {
        "format": "reforge-feature-recipe", "version": "1.0",
        "name": "small", "units": "mm",
        "features": [
            {"id": "f1", "type": "base_cylinder",
             "parameters": {"radius": 10.0, "zStart": 0.0, "zEnd": 20.0}},
            {"id": "f2", "type": "through_bore",
             "parameters": {"diameter": 6.0, "zStart": -1.0, "zEnd": 21.0},
             "depends_on": ["f1"]},
        ],
        "expected": {"bbox": {"xlen": 20.0, "ylen": 20.0, "zlen": 20.0}},
        "metadata": {},
    }
    return ic.interface_from_recipe(recipe, provenance="measured", uncertainty=0.01)


def test_endpoint_contract_only():
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest

    payload = ReconstructionCadRequest(
        job_id="recon_contract", interface=_small_interface(), model=False)
    res = cad_from_reconstruction_endpoint(payload)
    assert isinstance(res, dict)
    assert res["status"] == "success"
    assert res["mode"] == "contract_only"
    assert res["recipe"]["features"]


def test_endpoint_models_and_exports(tmp_path):
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest

    payload = ReconstructionCadRequest(
        job_id="recon_model", interface=_small_interface(),
        model=True, output_dir=str(tmp_path))
    res = cad_from_reconstruction_endpoint(payload)
    assert res["status"] == "success"
    assert res["mode"] == "feature"
    assert res["validation_report"]["valid"] is True
    assert os.path.isfile(res["step_path"])
    assert os.path.isfile(res["stl_path"])


def test_endpoint_rejects_invalid_interface():
    from app import cad_from_reconstruction_endpoint, ReconstructionCadRequest
    from fastapi.responses import JSONResponse

    doc = _small_interface()
    doc["dimensions"].pop("f1__radius")
    payload = ReconstructionCadRequest(job_id="recon_bad", interface=doc, model=False)
    res = cad_from_reconstruction_endpoint(payload)
    assert isinstance(res, JSONResponse)
    assert res.status_code == 422
