"""
test_image_to_cad_optimizer.py — Unit test for closed-loop image-to-CAD refinement.
"""

import numpy as np
import pytest
from reconstruction.image_to_cad_optimizer import (
    render_recipe_silhouette,
    compute_mask_iou,
    optimize_recipe_against_vision,
)


def test_silhouette_rendering_and_iou():
    recipe = {
        "style": "axial_segments",
        "axialSegments": [
            {"zStart": -50, "zEnd": 0, "radius": 20, "label": "Stage 1"},
            {"zStart": 0, "zEnd": 50, "radius": 30, "label": "Stage 2"},
        ],
    }
    mask = render_recipe_silhouette(recipe, (256, 256), mm_per_pixel=1.0)
    assert mask.shape == (256, 256)
    assert np.sum(mask > 128) > 1000

    # Self-IoU must be 1.0
    iou = compute_mask_iou(mask, mask)
    assert abs(iou - 1.0) < 1e-4


def test_optimization_convergence():
    # Ground truth recipe with exact radii: 15 and 25
    true_recipe = {
        "style": "axial_segments",
        "axialSegments": [
            {"zStart": -40, "zEnd": 0, "radius": 15.0},
            {"zStart": 0, "zEnd": 40, "radius": 25.0},
        ],
    }
    target_mask = render_recipe_silhouette(true_recipe, (256, 256), mm_per_pixel=1.0)

    # Distorted candidate recipe with incorrect initial radii: 20 and 18
    candidate_recipe = {
        "style": "axial_segments",
        "axialSegments": [
            {"zStart": -40, "zEnd": 0, "radius": 20.0},
            {"zStart": 0, "zEnd": 40, "radius": 18.0},
        ],
    }

    res = optimize_recipe_against_vision(
        candidate_recipe,
        target_mask,
        mm_per_pixel=1.0,
        max_evaluations=30,
    )

    assert res.final_iou > res.initial_iou
    assert res.final_residual < res.initial_residual

    # Optimized radii should approach 15 and 25
    opt_segs = res.optimized_recipe["axialSegments"]
    assert abs(opt_segs[0]["radius"] - 15.0) < 3.0
    assert abs(opt_segs[1]["radius"] - 25.0) < 3.0
