"""
advanced_housing.py — Reference acceptance specimen for the advanced CAD layer.

A deterministic, fully dimensioned mechanical housing that exercises Stage 1
(external mechanical modelling) and Stage 2 (internal geometry / machining)
features:

* a central cylindrical housing,
* a mounting flange with a bolt circle of mounting holes,
* an upper internal cavity feeding a stepped bore,
* multiple side-facing radial ports,
* external cylindrical bosses and structural ribs,
* an intersecting internal passage network (two cross-drillings),
* machined edges (fillets / chamfers) where geometrically valid.

All dimensions are explicit and in millimetres.  The recipe is intentionally
kept out of the production modules: it is a demonstration and acceptance test,
not an automatic reconstruction of any photograph.

Coordinate system: global Z is the housing axis; the origin is the centre of
the flange base plane (z = 0).
"""

from __future__ import annotations

from typing import Any, Dict

try:
    from cad.feature_schema import FEATURE_RECIPE_FORMAT, FEATURE_RECIPE_VERSION
except ImportError:  # pragma: no cover
    from python_engine.cad.feature_schema import FEATURE_RECIPE_FORMAT, FEATURE_RECIPE_VERSION  # type: ignore


# ---------------------------------------------------------------------------
# Documented dimensions (mm)
# ---------------------------------------------------------------------------

HOUSING_DIMENSIONS: Dict[str, float] = {
    # Mounting flange
    "flange_outer_radius": 80.0,
    "flange_thickness": 12.0,
    # Central housing body
    "body_outer_radius": 45.0,
    "body_height": 90.0,
    # Mounting hole pattern
    "mounting_hole_count": 6,
    "mounting_bolt_circle_radius": 62.0,
    "mounting_hole_diameter": 8.0,
    # Internal cavity + stepped bore
    "upper_cavity_diameter": 50.0,
    "upper_cavity_z_start": 50.0,
    "upper_cavity_z_end": 92.0,
    "step_bore_diameter": 28.0,
    "step_bore_z_start": 35.0,
    "step_bore_z_end": 52.0,
    "through_bore_diameter": 14.0,
    "through_bore_z_start": -1.0,
    "through_bore_z_end": 37.0,
    # Side ports and bosses
    "port_count": 3,
    "port_diameter": 14.0,
    "port_z": 70.0,
    "port_start_radius": 62.0,
    "boss_radius": 18.0,
    "boss_start_radius": 44.0,
    "boss_height": 16.0,
    # Structural ribs
    "rib_count": 4,
    "rib_length": 32.0,
    "rib_thickness": 8.0,
    "rib_height": 38.0,
    "rib_start_radius": 44.0,
    "rib_z": 12.0,
    # Intersecting internal passages
    "passage_diameter": 8.0,
    "passage_offset": 20.0,
    "passage_z": 25.0,
    # Machined edges
    "junction_fillet_radius": 3.0,
    "chamfer_size": 1.5,
}

#: Azimuth (deg) of each side port / boss.
_PORT_ANGLES = [0.0, 120.0, 240.0]
#: Azimuth (deg) of each structural rib (between the ports).
_RIB_ANGLES = [45.0, 135.0, 225.0, 315.0]

#: Expected bounding box (mm) of the finished housing.
EXPECTED_BBOX = {"xlen": 160.0, "ylen": 160.0, "zlen": 90.0}


# ---------------------------------------------------------------------------
# Recipe construction
# ---------------------------------------------------------------------------

def build_advanced_housing_recipe() -> Dict[str, Any]:
    """Return the deterministic advanced feature recipe for the housing."""
    d = HOUSING_DIMENSIONS
    features: list = []

    # 1. Mounting flange (circular plate).
    features.append({
        "id": "flange",
        "type": "flange",
        "parameters": {"shape": "circular", "outerRadius": d["flange_outer_radius"],
                       "thickness": d["flange_thickness"], "zStart": 0.0},
        "metadata": {"note": "Mounting flange base plate."},
    })

    # 2. Central cylindrical housing body.
    features.append({
        "id": "body",
        "type": "base_cylinder",
        "parameters": {"radius": d["body_outer_radius"], "zStart": 0.0, "zEnd": d["body_height"]},
        "depends_on": ["flange"],
        "metadata": {"note": "Central housing cylinder, coaxial with the flange."},
    })

    # 3. Concave fillet at the body/flange junction (before ribs interrupt it).
    features.append({
        "id": "junction_fillet",
        "type": "fillet",
        "parameters": {"radius": d["junction_fillet_radius"],
                       "edges": [{"kind": "circle", "radius": d["body_outer_radius"], "z": d["flange_thickness"]}]},
        "depends_on": ["body"],
        "metadata": {"note": "Machined fillet at the cylinder-to-flange junction."},
    })

    # 4. Bolt circle of mounting holes through the flange.
    features.append({
        "id": "mounting_holes",
        "type": "bolt_circle",
        "parameters": {
            "count": d["mounting_hole_count"],
            "boltCircleRadius": d["mounting_bolt_circle_radius"],
            "holeDiameter": d["mounting_hole_diameter"],
            "zStart": -1.0, "zEnd": d["flange_thickness"] + 1.0,
            "startAngleDeg": 0.0,
        },
        "depends_on": ["flange"],
        "metadata": {"note": "6x M8 through-holes on a 62 mm bolt circle."},
    })

    # 5. Structural ribs (gussets) between flange and body.
    for i, ang in enumerate(_RIB_ANGLES):
        features.append({
            "id": f"rib_{i + 1}",
            "type": "rib",
            "parameters": {
                "length": d["rib_length"], "thickness": d["rib_thickness"], "height": d["rib_height"],
                "angleDeg": ang, "startRadius": d["rib_start_radius"], "z": d["rib_z"],
            },
            "depends_on": ["body", "flange"],
            "metadata": {"note": f"Radial structural rib at {ang} deg."},
        })

    # 6. External cylindrical bosses around each side port.
    for i, ang in enumerate(_PORT_ANGLES):
        features.append({
            "id": f"boss_{i + 1}",
            "type": "boss_cylindrical",
            "parameters": {
                "radius": d["boss_radius"], "angleDeg": ang, "z": d["port_z"],
                "startRadius": d["boss_start_radius"], "height": d["boss_height"],
            },
            "depends_on": ["body"],
            "metadata": {"note": f"External boss at {ang} deg housing a side port."},
        })

    # 7. Side-facing radial ports (outside -> internal cavity).
    for i, ang in enumerate(_PORT_ANGLES):
        features.append({
            "id": f"side_port_{i + 1}",
            "type": "radial_port",
            "parameters": {
                "diameter": d["port_diameter"], "angleDeg": ang, "z": d["port_z"],
                "startRadius": d["port_start_radius"], "depth": d["port_start_radius"],
            },
            "depends_on": [f"boss_{i + 1}", "body"],
            "metadata": {"note": f"Radial port at {ang} deg connecting outside to the cavity."},
        })

    # 8. Upper internal cavity (open to the top face).
    features.append({
        "id": "upper_cavity",
        "type": "cavity",
        "parameters": {
            "diameter": d["upper_cavity_diameter"], "center": {"x": 0.0, "y": 0.0},
            "zStart": d["upper_cavity_z_start"], "zEnd": d["upper_cavity_z_end"],
        },
        "depends_on": ["body"],
        "metadata": {"note": "Upper internal cavity, 50 mm diameter."},
    })

    # 9. Stepped bore below the cavity.
    features.append({
        "id": "step_bore",
        "type": "stepped_bore",
        "parameters": {
            "center": {"x": 0.0, "y": 0.0},
            "segments": [{"diameter": d["step_bore_diameter"],
                          "zStart": d["step_bore_z_start"], "zEnd": d["step_bore_z_end"]}],
        },
        "depends_on": ["upper_cavity"],
        "metadata": {"note": "28 mm intermediate bore, 35-52 mm."},
    })

    # 10. Through bore (base of the housing).
    features.append({
        "id": "through_bore",
        "type": "through_bore",
        "parameters": {
            "diameter": d["through_bore_diameter"], "center": {"x": 0.0, "y": 0.0},
            "zStart": d["through_bore_z_start"], "zEnd": d["through_bore_z_end"],
        },
        "depends_on": ["body"],
        "metadata": {"note": "14 mm through bore from the base."},
    })

    # 11 & 12. Intersecting internal cross-passages.
    off = d["passage_offset"]
    pz = d["passage_z"]
    features.append({
        "id": "passage_x",
        "type": "internal_passage",
        "parameters": {"diameter": d["passage_diameter"],
                       "start": {"x": -d["body_outer_radius"], "y": off, "z": pz},
                       "end": {"x": d["body_outer_radius"], "y": off, "z": pz}},
        "depends_on": ["body"],
        "metadata": {"note": "Cross-passage along X at y=+20, z=25."},
    })
    features.append({
        "id": "passage_y",
        "type": "internal_passage",
        "parameters": {"diameter": d["passage_diameter"],
                       "start": {"x": off, "y": -d["body_outer_radius"], "z": pz},
                       "end": {"x": off, "y": d["body_outer_radius"], "z": pz}},
        "depends_on": ["body"],
        "metadata": {"note": "Cross-passage along Y at x=+20, z=25; intersects passage_x."},
    })

    # 13-15. Machined edges (chamfers).
    features.append({
        "id": "chamfer_flange_top",
        "type": "chamfer",
        "parameters": {"distance": d["chamfer_size"],
                       "edges": [{"kind": "circle", "radius": d["flange_outer_radius"],
                                  "z": d["flange_thickness"]}]},
        "depends_on": ["flange"],
        "metadata": {"note": "Chamfer on the flange top outer edge."},
    })
    features.append({
        "id": "chamfer_flange_bottom",
        "type": "chamfer",
        "parameters": {"distance": d["chamfer_size"],
                       "edges": [{"kind": "circle", "radius": d["flange_outer_radius"], "z": 0.0}]},
        "depends_on": ["flange"],
        "metadata": {"note": "Chamfer on the flange bottom outer edge."},
    })
    features.append({
        "id": "chamfer_body_top",
        "type": "chamfer",
        "parameters": {"distance": d["chamfer_size"],
                       "edges": [{"kind": "circle", "radius": d["body_outer_radius"],
                                  "z": d["body_height"]}]},
        "depends_on": ["body", "upper_cavity"],
        "metadata": {"note": "Chamfer on the housing top rim."},
    })

    return {
        "format": FEATURE_RECIPE_FORMAT,
        "version": FEATURE_RECIPE_VERSION,
        "name": "advanced_mechanical_housing",
        "units": "mm",
        "features": features,
        "expected": {
            "solid_count": 1,
            "bbox": EXPECTED_BBOX,
            "bbox_tolerance": 0.01,
            "min_volume": 550000.0,
            "max_volume": 900000.0,
            "feature_counts": {
                "flange": 1,
                "base_cylinder": 1,
                "bolt_circle": 1,
                "rib": 4,
                "boss_cylindrical": 3,
                "radial_port": 3,
                "cavity": 1,
                "stepped_bore": 1,
                "through_bore": 1,
                "internal_passage": 2,
                "fillet": 1,
                "chamfer": 3,
            },
            "bore_count": 3,       # cavity + stepped bore + through bore
            "hole_count": 6,       # bolt circle
            "port_count": 3,       # radial ports
            "intersecting_passages": [["passage_x", "passage_y"]],
        },
        "metadata": {
            "dimensions": HOUSING_DIMENSIONS,
            "description": "Reference acceptance specimen for ReForge AI advanced CAD (Phase 1, Stages 1-2).",
        },
    }
