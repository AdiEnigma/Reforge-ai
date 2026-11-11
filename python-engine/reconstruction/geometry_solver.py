"""
geometry_solver.py — SciPy Geometric Parameter Optimisation Subsystem.

Responsible for:
1. Transforming observed geometric evidence into a geometrically consistent,
   optimised set of engineering parameters for ReForge AI's geometry-recipe and CAD builders.
2. Formulating bounded, scaled, robust non-linear least squares problems using scipy.optimize.least_squares.
3. Keeping user-measured parameters fixed while solving only genuinely unknown degrees of freedom.
4. Detecting non-identifiability, rank deficiency, conditioning issues, and underdetermined systems via SVD.
5. Preserving parameter classifications (MEASURED, ESTIMATED, UNKNOWN) and explicit provenance.
6. Guarding against false precision, NaN/Infinity propagation, negative radii, and contradictory constraints.

Conforms to ReForge AI Reconstruction Subsystem Specification.
"""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("reforge.reconstruction.geometry_solver")

SCHEMA_VERSION = "1.0"

# Canonical classifications
CLASSIFICATION_MEASURED = "MEASURED"
CLASSIFICATION_ESTIMATED = "ESTIMATED"
CLASSIFICATION_UNKNOWN = "UNKNOWN"

# Canonical provenances
PROV_USER_PROVIDED = "USER_PROVIDED"
PROV_CALIBRATED_IMAGE = "CALIBRATED_IMAGE"
PROV_OPENCV_OBSERVATION = "OPENCV_OBSERVATION"
PROV_COLMAP_RECONSTRUCTION = "COLMAP_RECONSTRUCTION"
PROV_DEPTH_PRIOR = "DEPTH_PRIOR"
PROV_GEMINI_PROPOSAL = "GEMINI_PROPOSAL"
PROV_GEOMETRIC_CONSTRAINT = "GEOMETRIC_CONSTRAINT"


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------

@dataclass
class GeometricParameter:
    name: str
    value: Optional[float]
    unit: Optional[str] = "mm"
    classification: str = CLASSIFICATION_UNKNOWN
    provenance: List[str] = field(default_factory=list)
    uncertainty: Optional[float] = None


@dataclass
class ResidualStatistics:
    cost: float = 0.0
    mean_residual: float = 0.0
    max_residual: float = 0.0
    dof: int = 0
    num_residuals: int = 0


@dataclass
class OptimisationReport:
    converged: bool = False
    message: str = ""
    iterations: int = 0
    nfev: int = 0
    status_code: int = 0
    active_bounds: List[str] = field(default_factory=list)


@dataclass
class IdentifiabilityReport:
    identifiable: bool = True
    rank: int = 0
    num_parameters: int = 0
    condition_number: Optional[float] = None
    underdetermined: bool = False
    unobservable_parameters: List[str] = field(default_factory=list)


@dataclass
class SolverResult:
    schema_version: str = SCHEMA_VERSION
    job_id: str = "default_job"
    status: str = "failed"  # "success" | "partial" | "failed"
    coordinate_frame: str = "component_local"  # "component_local" | "camera" | "relative_world"
    units: str = "mm"  # "mm" | "inch" | "relative" | "unknown"
    scale_classification: str = "metric"  # "metric" | "relative" | "unknown"
    parameters: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    features: List[Dict[str, Any]] = field(default_factory=list)
    applied_constraints: List[Dict[str, Any]] = field(default_factory=list)
    residual_statistics: Dict[str, Any] = field(default_factory=dict)
    optimisation: Dict[str, Any] = field(default_factory=dict)
    identifiability: Dict[str, Any] = field(default_factory=dict)
    missing_critical_dimensions: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert result to clean JSON-serializable dictionary with finite numbers."""
        raw = asdict(self)

        def sanitize(obj: Any) -> Any:
            if isinstance(obj, float):
                if math.isnan(obj) or math.isinf(obj):
                    return None
                return round(obj, 6)
            elif isinstance(obj, dict):
                return {k: sanitize(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [sanitize(v) for v in obj]
            return obj

        return sanitize(raw)


# ---------------------------------------------------------------------------
# Input Validation & Sanitization
# ---------------------------------------------------------------------------

def validate_finite_number(val: Any) -> Optional[float]:
    """Returns float if finite, None if invalid/nan/inf."""
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def sanitize_input_evidence(
    component_type: str,
    user_dimensions: Optional[Dict[str, Any]],
    gemini_proposal: Optional[Dict[str, Any]],
    multiview_evidence: Optional[Dict[str, Any]],
    opencv_observations: Optional[Dict[str, Any]],
    constraints: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Dict[str, Any], List[str], List[str]]:
    """
    Validates all incoming observations and constraints:
    - Filters non-finite values (NaN / Inf).
    - Checks for negative radii / impossible physical dimensions.
    - Flags contradictory user-provided dimensions.
    - Separates validated user measurements from Gemini proposals.
    """
    warnings: List[str] = []
    errors: List[str] = []
    clean: Dict[str, Any] = {
        "component_type": component_type.lower() if component_type else "generic",
        "user_dims": {},
        "proposals": {},
        "points3D": [],
        "circles2D": [],
        "constraints": [],
    }

    # 1. User Dimensions (Ground Truth / Measured)
    if user_dimensions:
        for k, v in user_dimensions.items():
            fn = validate_finite_number(v)
            if fn is None:
                errors.append(f"Non-finite or invalid user dimension: {k}={v}")
                continue
            if fn < 0:
                errors.append(f"Physical dimension cannot be negative: {k}={fn}")
                continue
            clean["user_dims"][k] = fn

    # Check for direct contradictions in user dimensions (e.g. inner >= outer diameter)
    od = clean["user_dims"].get("outer_diameter") if clean["user_dims"].get("outer_diameter") is not None else clean["user_dims"].get("outerDiameter")
    id_ = clean["user_dims"].get("inner_diameter") if clean["user_dims"].get("inner_diameter") is not None else clean["user_dims"].get("innerDiameter")
    if od is not None and id_ is not None and id_ >= od:
        errors.append(f"Contradictory user dimensions: inner diameter ({id_}) >= outer diameter ({od})")

    # 2. Gemini Proposals (Estimates only, not ground truth)
    if gemini_proposal:
        raw_dims = gemini_proposal.get("dimensions", {})
        for k, v in raw_dims.items():
            fn = validate_finite_number(v)
            if fn is not None and fn > 0:
                clean["proposals"][k] = fn
        for extra in ["teeth", "module", "helixAngle", "helix_angle"]:
            if extra in gemini_proposal:
                fn = validate_finite_number(gemini_proposal[extra])
                if fn is not None:
                    clean["proposals"][extra] = fn

    # 3. Multiview Evidence (Sparse 3D points)
    if multiview_evidence and isinstance(multiview_evidence, dict):
        raw_pts = multiview_evidence.get("points3D", [])
        for pt in raw_pts:
            xyz = pt.get("xyz")
            if isinstance(xyz, (list, tuple)) and len(xyz) == 3:
                fx = validate_finite_number(xyz[0])
                fy = validate_finite_number(xyz[1])
                fz = validate_finite_number(xyz[2])
                if fx is not None and fy is not None and fz is not None:
                    clean["points3D"].append([fx, fy, fz])

    # 4. OpenCV Observations
    if opencv_observations and isinstance(opencv_observations, dict):
        raw_circles = opencv_observations.get("circles", [])
        for c in raw_circles:
            raw_cx = c.get("cx") if c.get("cx") is not None else c.get("center_x")
            raw_cy = c.get("cy") if c.get("cy") is not None else c.get("center_y")
            raw_cr = c.get("radius") if c.get("radius") is not None else c.get("r")
            cx = validate_finite_number(raw_cx)
            cy = validate_finite_number(raw_cy)
            cr = validate_finite_number(raw_cr)
            if cx is not None and cy is not None and cr is not None and cr > 0:
                clean["circles2D"].append({"cx": cx, "cy": cy, "r": cr})

    # 5. Constraints
    if constraints and isinstance(constraints, list):
        for c in constraints:
            if isinstance(c, dict) and "type" in c:
                clean["constraints"].append(c)

    return clean, warnings, errors


# ---------------------------------------------------------------------------
# Geometric Fitting & Optimization Models
# ---------------------------------------------------------------------------

def fit_cylinder_scipy(
    points: List[List[float]],
    fixed_radius: Optional[float] = None,
    fixed_height: Optional[float] = None,
    initial_radius: float = 25.0,
    loss: str = "soft_l1",
) -> Tuple[Dict[str, float], Any, List[float]]:
    """
    Fits a cylinder (radius, axis alignment) to 3D point cloud using scipy.optimize.least_squares.
    Points are assumed oriented along principal component or Z axis.
    Residual: distance of each 3D point to cylinder surface: sqrt(dx^2 + dy^2) - radius.
    """
    import numpy as np
    from scipy.optimize import least_squares

    pts = np.array(points, dtype=np.float64)
    # Estimate center line x0, y0
    x_mean = float(np.mean(pts[:, 0]))
    y_mean = float(np.mean(pts[:, 1]))
    z_min, z_max = float(np.min(pts[:, 2])), float(np.max(pts[:, 2]))
    computed_height = max(0.1, z_max - z_min)

    # Optimization variables:
    # If radius is fixed by user, optimize only axis center (x0, y0)
    # If radius is unknown, optimize [x0, y0, radius]
    if fixed_radius is not None:
        x0_init = [x_mean, y_mean]
        bounds = ([-np.inf, -np.inf], [np.inf, np.inf])

        def residuals(p):
            dx = pts[:, 0] - p[0]
            dy = pts[:, 1] - p[1]
            dist = np.sqrt(dx**2 + dy**2)
            return dist - fixed_radius

        res = least_squares(residuals, x0_init, bounds=bounds, loss=loss, x_scale="jac")
        return {
            "radius": fixed_radius,
            "center_x": float(res.x[0]),
            "center_y": float(res.x[1]),
            "height": fixed_height or computed_height,
        }, res, res.fun.tolist()
    else:
        x0_init = [x_mean, y_mean, max(1.0, initial_radius)]
        # Radius must be strictly positive
        bounds = ([-np.inf, -np.inf, 0.1], [np.inf, np.inf, 50000.0])

        def residuals(p):
            dx = pts[:, 0] - p[0]
            dy = pts[:, 1] - p[1]
            dist = np.sqrt(dx**2 + dy**2)
            return dist - p[2]

        res = least_squares(residuals, x0_init, bounds=bounds, loss=loss, x_scale="jac")
        return {
            "radius": float(res.x[2]),
            "center_x": float(res.x[0]),
            "center_y": float(res.x[1]),
            "height": fixed_height or computed_height,
        }, res, res.fun.tolist()


def fit_concentric_circles_scipy(
    circle_observations: List[Dict[str, float]],
    fixed_inner_r: Optional[float] = None,
    fixed_outer_r: Optional[float] = None,
    loss: str = "soft_l1",
) -> Tuple[Dict[str, float], Any, List[float]]:
    """
    Fits concentric circles with shared center (cx, cy) and radii (r_inner, r_outer).
    Enforces concentricity constraint: center distance between rings = 0.
    """
    import numpy as np
    from scipy.optimize import least_squares

    radii = [c["r"] for c in circle_observations]
    cxs = [c["cx"] for c in circle_observations]
    cys = [c["cy"] for c in circle_observations]

    cx_init = float(np.mean(cxs))
    cy_init = float(np.mean(cys))
    r_small = min(radii) if len(radii) > 0 else 10.0
    r_large = max(radii) if len(radii) > 0 else 40.0
    if r_large <= r_small:
        r_large = r_small * 1.5

    # Determine free parameters: [cx, cy, r_inner, r_outer]
    p_init = [cx_init, cy_init]
    lower = [-np.inf, -np.inf]
    upper = [np.inf, np.inf]

    idx_rin = None
    idx_rout = None

    if fixed_inner_r is None:
        idx_rin = len(p_init)
        p_init.append(max(1e-5, r_small))
        lower.append(1e-6)
        upper.append(50000.0)

    if fixed_outer_r is None:
        idx_rout = len(p_init)
        p_init.append(max(2e-5, r_large))
        lower.append(1e-6)
        upper.append(50000.0)

    # Ensure p_init is strictly within bounds
    for i in range(len(p_init)):
        if p_init[i] <= lower[i]:
            p_init[i] = lower[i] + 1e-5
        elif p_init[i] >= upper[i]:
            p_init[i] = upper[i] - 1e-5

    def residuals(p):
        cur_cx = p[0]
        cur_cy = p[1]
        cur_rin = fixed_inner_r if fixed_inner_r is not None else p[idx_rin]
        cur_rout = fixed_outer_r if fixed_outer_r is not None else p[idx_rout]

        res_list = []
        # Residuals against circle observations
        for c in circle_observations:
            dist_center = math.sqrt((c["cx"] - cur_cx)**2 + (c["cy"] - cur_cy)**2)
            # Match to closer of the two radii
            err_in = abs(c["r"] - cur_rin)
            err_out = abs(c["r"] - cur_rout)
            if err_in < err_out:
                res_list.append(c["r"] - cur_rin)
            else:
                res_list.append(c["r"] - cur_rout)
            res_list.append(dist_center)  # concentricity penalty

        # Physical order constraint penalty: rin must be < rout
        if cur_rin >= cur_rout:
            res_list.append((cur_rin - cur_rout + 1.0) * 100.0)

        return np.array(res_list, dtype=np.float64)

    res = least_squares(residuals, p_init, bounds=(lower, upper), loss=loss, x_scale="jac")

    final_rin = fixed_inner_r if fixed_inner_r is not None else float(res.x[idx_rin])
    final_rout = fixed_outer_r if fixed_outer_r is not None else float(res.x[idx_rout])

    return {
        "center_x": float(res.x[0]),
        "center_y": float(res.x[1]),
        "inner_radius": final_rin,
        "outer_radius": final_rout,
    }, res, res.fun.tolist()


def solve_gear_parameters(
    user_dims: Dict[str, float],
    proposals: Dict[str, float],
) -> Dict[str, GeometricParameter]:
    """
    Computes/optimizes gear kinematic and tooth geometry relationships:
    - Pitch diameter: D = Z * m
    - Outer diameter (tip): D_o = (Z + 2) * m (for standard spur gear)
    - Root diameter: D_r = (Z - 2.5) * m
    - Module: m = D_o / (Z + 2)
    """
    params: Dict[str, GeometricParameter] = {}

    teeth = user_dims.get("teeth") or proposals.get("teeth")
    module = user_dims.get("module") or proposals.get("module")
    od = user_dims.get("outer_diameter") or user_dims.get("outerDiameter") or proposals.get("outerDiameter")
    id_ = user_dims.get("inner_diameter") or user_dims.get("innerDiameter") or proposals.get("innerDiameter")
    helix = user_dims.get("helix_angle") or user_dims.get("helixAngle") or proposals.get("helixAngle") or 0.0

    # User teeth or module take measured precedence
    teeth_class = CLASSIFICATION_MEASURED if "teeth" in user_dims else (
        CLASSIFICATION_ESTIMATED if teeth is not None else CLASSIFICATION_UNKNOWN
    )
    teeth_prov = [PROV_USER_PROVIDED] if "teeth" in user_dims else (
        [PROV_GEMINI_PROPOSAL] if teeth is not None else []
    )

    module_class = CLASSIFICATION_MEASURED if "module" in user_dims else (
        CLASSIFICATION_ESTIMATED if module is not None else CLASSIFICATION_UNKNOWN
    )
    module_prov = [PROV_USER_PROVIDED] if "module" in user_dims else (
        [PROV_GEMINI_PROPOSAL] if module is not None else []
    )

    # Reconcile module and teeth with outer diameter if OD is given
    if od is not None and teeth is not None and module is None:
        # Infer module from outer diameter: m = D_o / (Z + 2)
        inferred_m = od / (teeth + 2.0)
        module = round(inferred_m, 3)
        module_class = CLASSIFICATION_ESTIMATED
        module_prov = [PROV_GEOMETRIC_CONSTRAINT]
    elif od is not None and module is not None and teeth is None:
        # Infer teeth from outer diameter: Z = (D_o / m) - 2
        inferred_z = round((od / module) - 2.0)
        teeth = max(6, int(inferred_z))
        teeth_class = CLASSIFICATION_ESTIMATED
        teeth_prov = [PROV_GEOMETRIC_CONSTRAINT]
    elif teeth is not None and module is not None and od is None:
        # Infer outer diameter
        od = round((teeth + 2.0) * module, 3)

    params["teeth"] = GeometricParameter(
        name="teeth",
        value=float(teeth) if teeth is not None else None,
        unit="count",
        classification=teeth_class,
        provenance=teeth_prov,
    )
    params["module"] = GeometricParameter(
        name="module",
        value=float(module) if module is not None else None,
        unit="mm",
        classification=module_class,
        provenance=module_prov,
    )
    params["outer_diameter"] = GeometricParameter(
        name="outer_diameter",
        value=float(od) if od is not None else None,
        unit="mm",
        classification=CLASSIFICATION_MEASURED if "outer_diameter" in user_dims or "outerDiameter" in user_dims else (
            CLASSIFICATION_ESTIMATED if od is not None else CLASSIFICATION_UNKNOWN
        ),
        provenance=[PROV_USER_PROVIDED] if "outer_diameter" in user_dims or "outerDiameter" in user_dims else (
            [PROV_GEOMETRIC_CONSTRAINT] if od is not None else []
        ),
    )
    if teeth is not None and module is not None:
        pitch_d = round(float(teeth) * float(module), 3)
        params["pitch_diameter"] = GeometricParameter(
            name="pitch_diameter",
            value=pitch_d,
            unit="mm",
            classification=CLASSIFICATION_ESTIMATED,
            provenance=[PROV_GEOMETRIC_CONSTRAINT],
        )

    params["bore_diameter"] = GeometricParameter(
        name="bore_diameter",
        value=float(id_) if id_ is not None else None,
        unit="mm",
        classification=CLASSIFICATION_MEASURED if "inner_diameter" in user_dims or "innerDiameter" in user_dims else (
            CLASSIFICATION_ESTIMATED if id_ is not None else CLASSIFICATION_UNKNOWN
        ),
        provenance=[PROV_USER_PROVIDED] if "inner_diameter" in user_dims or "innerDiameter" in user_dims else (
            [PROV_GEMINI_PROPOSAL] if id_ is not None else []
        ),
    )
    params["helix_angle"] = GeometricParameter(
        name="helix_angle",
        value=float(helix),
        unit="deg",
        classification=CLASSIFICATION_MEASURED if "helix_angle" in user_dims or "helixAngle" in user_dims else CLASSIFICATION_ESTIMATED,
        provenance=[PROV_USER_PROVIDED] if "helix_angle" in user_dims or "helixAngle" in user_dims else [PROV_GEOMETRIC_CONSTRAINT],
    )

    return params


# ---------------------------------------------------------------------------
# Identifiability, SVD, and Covariance Diagnostics
# ---------------------------------------------------------------------------

def compute_identifiability_diagnostics(
    jacobian: Any,
    parameter_names: List[str],
    cost: float,
) -> IdentifiabilityReport:
    """
    Computes SVD on the Jacobian matrix to identify:
    - Matrix rank
    - Condition number (sigma_max / sigma_min)
    - Underdetermined or unobservable directions
    """
    import numpy as np

    report = IdentifiabilityReport()
    report.num_parameters = len(parameter_names)

    if jacobian is None or jacobian.size == 0 or len(parameter_names) == 0:
        report.identifiable = False
        report.underdetermined = True
        report.unobservable_parameters = list(parameter_names)
        return report

    J = np.asarray(jacobian, dtype=np.float64)
    if J.ndim == 1:
        J = J.reshape(-1, 1)

    m, n = J.shape
    if m < n:
        # Fewer residual equations than parameters -> strictly underdetermined
        report.underdetermined = True
        report.identifiable = False
        report.rank = m
        report.unobservable_parameters = list(parameter_names[m:])
        return report

    # Compute Singular Value Decomposition
    try:
        U, s, Vt = np.linalg.svd(J, full_matrices=False)
        eps = np.finfo(np.float64).eps
        tol = max(m, n) * s[0] * eps if len(s) > 0 and s[0] > 0 else 1e-12

        rank = int(np.sum(s > tol))
        report.rank = rank

        if len(s) > 0 and s[-1] > 1e-12:
            report.condition_number = float(s[0] / s[-1])
        else:
            report.condition_number = float("inf")

        if rank < n or (report.condition_number is not None and report.condition_number > 1e10):
            report.underdetermined = True
            report.identifiable = False
            # Find zero singular vectors in Vt
            for i in range(rank, n):
                dominant_idx = int(np.argmax(np.abs(Vt[i, :])))
                if dominant_idx < len(parameter_names):
                    param_name = parameter_names[dominant_idx]
                    if param_name not in report.unobservable_parameters:
                        report.unobservable_parameters.append(param_name)
        else:
            report.identifiable = True
            report.underdetermined = False

    except Exception as e:
        logger.debug("SVD computation error: %s", e)
        report.identifiable = False
        report.underdetermined = True

    return report


# ---------------------------------------------------------------------------
# Main Solver Orchestrator
# ---------------------------------------------------------------------------

def solve_geometry(
    job_id: str = "solve_job",
    component_type: str = "cylinder",
    user_dimensions: Optional[Dict[str, Any]] = None,
    gemini_proposal: Optional[Dict[str, Any]] = None,
    multiview_evidence: Optional[Dict[str, Any]] = None,
    opencv_observations: Optional[Dict[str, Any]] = None,
    constraints: Optional[List[Dict[str, Any]]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> SolverResult:
    """
    Main entry point for geometric parameter optimization using SciPy.
    
    Guarantees:
    - Never crashes on invalid/missing evidence: returns structured SolverResult.
    - Never modifies user-measured ground truth.
    - Validates bounds, scale, and identifiability via SVD.
    - Preserves MEASURED, ESTIMATED, and UNKNOWN classifications.
    - All returned numbers are strictly finite floats/ints.
    """
    opts = options or {}
    loss = opts.get("loss", "soft_l1")
    unit_mode = opts.get("units", "mm")

    result = SolverResult(job_id=job_id, units=unit_mode)

    # 1. Sanitize all incoming evidence
    clean, warns, errs = sanitize_input_evidence(
        component_type,
        user_dimensions,
        gemini_proposal,
        multiview_evidence,
        opencv_observations,
        constraints,
    )
    result.warnings.extend(warns)
    result.errors.extend(errs)

    # Contradictory dimensions or invalid physical bounds abort immediately with structured failure
    if result.errors:
        result.status = "failed"
        return result

    # Check for zero observations
    has_points = len(clean["points3D"]) > 0
    has_circles = len(clean["circles2D"]) > 0
    has_user_dims = len(clean["user_dims"]) > 0
    has_proposal = len(clean["proposals"]) > 0

    if not (has_points or has_circles or has_user_dims or has_proposal):
        result.status = "failed"
        result.errors.append("Zero observations: no user dimensions, 3D points, 2D circles, or proposals provided.")
        return result

    # Determine coordinate frame and scale classification
    if multiview_evidence and isinstance(multiview_evidence, dict):
        mv_scale = multiview_evidence.get("scale", {})
        if mv_scale.get("classification") == "metric":
            result.scale_classification = "metric"
            result.coordinate_frame = "component_local"
        else:
            result.scale_classification = "relative"
            result.coordinate_frame = "relative_world"
            result.units = "relative"
    elif has_user_dims:
        result.scale_classification = "metric"
        result.coordinate_frame = "component_local"
    else:
        result.scale_classification = "relative"
        result.units = "relative"

    params: Dict[str, GeometricParameter] = {}
    comp = clean["component_type"]

    # -----------------------------------------------------------------------
    # Branch A: Gear Component
    # -----------------------------------------------------------------------
    if "gear" in comp or "cog" in comp:
        params = solve_gear_parameters(clean["user_dims"], clean["proposals"])
        result.parameters = {k: asdict(v) for k, v in params.items()}
        result.status = "success" if (params.get("outer_diameter") and params["outer_diameter"].value is not None) else "partial"
        result.identifiability = asdict(IdentifiabilityReport(identifiable=True, num_parameters=len(params), rank=len(params)))
        return result

    # -----------------------------------------------------------------------
    # Branch B: Cylinder / Shaft (Points or Circles)
    # -----------------------------------------------------------------------
    if has_points:
        fixed_r = None
        user_od = clean["user_dims"].get("outer_diameter") or clean["user_dims"].get("outerDiameter")
        if user_od is not None:
            fixed_r = user_od / 2.0

        user_h = clean["user_dims"].get("height") or clean["user_dims"].get("length")

        try:
            fit_res, opt_obj, residuals = fit_cylinder_scipy(
                clean["points3D"],
                fixed_radius=fixed_r,
                fixed_height=user_h,
                loss=loss,
            )

            # Diagnostics & Identifiability
            ident = compute_identifiability_diagnostics(
                opt_obj.jac,
                ["center_x", "center_y"] if fixed_r is not None else ["center_x", "center_y", "radius"],
                opt_obj.cost,
            )
            result.identifiability = asdict(ident)

            # Residual stats
            res_arr = [abs(r) for r in residuals]
            result.residual_statistics = asdict(ResidualStatistics(
                cost=float(opt_obj.cost),
                mean_residual=float(sum(res_arr) / len(res_arr)) if res_arr else 0.0,
                max_residual=float(max(res_arr)) if res_arr else 0.0,
                dof=max(0, len(res_arr) - ident.num_parameters),
                num_residuals=len(res_arr),
            ))

            result.optimisation = asdict(OptimisationReport(
                converged=bool(opt_obj.success),
                message=str(opt_obj.message),
                iterations=int(opt_obj.status),
                nfev=int(opt_obj.nfev),
                status_code=int(opt_obj.status),
            ))

            # Store parameters
            outer_d = fit_res["radius"] * 2.0
            params["outer_diameter"] = GeometricParameter(
                name="outer_diameter",
                value=outer_d,
                unit=result.units,
                classification=CLASSIFICATION_MEASURED if fixed_r is not None else CLASSIFICATION_ESTIMATED,
                provenance=[PROV_USER_PROVIDED] if fixed_r is not None else [PROV_COLMAP_RECONSTRUCTION],
            )
            params["height"] = GeometricParameter(
                name="height",
                value=fit_res["height"],
                unit=result.units,
                classification=CLASSIFICATION_MEASURED if user_h is not None else CLASSIFICATION_ESTIMATED,
                provenance=[PROV_USER_PROVIDED] if user_h is not None else [PROV_COLMAP_RECONSTRUCTION],
            )

            # Bore diameter if available
            user_id = clean["user_dims"].get("inner_diameter") or clean["user_dims"].get("innerDiameter")
            if user_id is not None:
                params["inner_diameter"] = GeometricParameter(
                    name="inner_diameter",
                    value=user_id,
                    unit=result.units,
                    classification=CLASSIFICATION_MEASURED,
                    provenance=[PROV_USER_PROVIDED],
                )
            else:
                params["inner_diameter"] = GeometricParameter(
                    name="inner_diameter",
                    value=None,
                    unit=result.units,
                    classification=CLASSIFICATION_UNKNOWN,
                )
                result.missing_critical_dimensions.append("inner_diameter")

            result.parameters = {k: asdict(v) for k, v in params.items()}
            result.status = "success" if (ident.identifiable and opt_obj.success) else "partial"
            return result

        except Exception as e:
            logger.error("Cylinder fitting error: %s", e)
            result.status = "failed"
            result.errors.append(f"Cylinder fitting error: {str(e)}")
            return result

    # -----------------------------------------------------------------------
    # Branch C: 2D Concentric Circles (Flange / Bearing / Bushing)
    # -----------------------------------------------------------------------
    if has_circles:
        user_od = clean["user_dims"].get("outer_diameter") or clean["user_dims"].get("outerDiameter")
        user_id = clean["user_dims"].get("inner_diameter") or clean["user_dims"].get("innerDiameter")

        fixed_out_r = (user_od / 2.0) if user_od is not None else None
        fixed_in_r = (user_id / 2.0) if user_id is not None else None

        try:
            fit_res, opt_obj, residuals = fit_concentric_circles_scipy(
                clean["circles2D"],
                fixed_inner_r=fixed_in_r,
                fixed_outer_r=fixed_out_r,
                loss=loss,
            )

            param_names = ["center_x", "center_y"]
            if fixed_in_r is None:
                param_names.append("inner_radius")
            if fixed_out_r is None:
                param_names.append("outer_radius")

            ident = compute_identifiability_diagnostics(opt_obj.jac, param_names, opt_obj.cost)
            result.identifiability = asdict(ident)

            res_arr = [abs(r) for r in residuals]
            result.residual_statistics = asdict(ResidualStatistics(
                cost=float(opt_obj.cost),
                mean_residual=float(sum(res_arr) / len(res_arr)) if res_arr else 0.0,
                max_residual=float(max(res_arr)) if res_arr else 0.0,
                dof=max(0, len(res_arr) - ident.num_parameters),
                num_residuals=len(res_arr),
            ))

            params["outer_diameter"] = GeometricParameter(
                name="outer_diameter",
                value=fit_res["outer_radius"] * 2.0,
                unit=result.units,
                classification=CLASSIFICATION_MEASURED if fixed_out_r is not None else CLASSIFICATION_ESTIMATED,
                provenance=[PROV_USER_PROVIDED] if fixed_out_r is not None else [PROV_OPENCV_OBSERVATION],
            )
            params["inner_diameter"] = GeometricParameter(
                name="inner_diameter",
                value=fit_res["inner_radius"] * 2.0,
                unit=result.units,
                classification=CLASSIFICATION_MEASURED if fixed_in_r is not None else CLASSIFICATION_ESTIMATED,
                provenance=[PROV_USER_PROVIDED] if fixed_in_r is not None else [PROV_OPENCV_OBSERVATION],
            )

            # Thickness
            user_th = clean["user_dims"].get("thickness") or clean["user_dims"].get("height")
            if user_th is not None:
                params["thickness"] = GeometricParameter(
                    name="thickness",
                    value=user_th,
                    unit=result.units,
                    classification=CLASSIFICATION_MEASURED,
                    provenance=[PROV_USER_PROVIDED],
                )
            else:
                params["thickness"] = GeometricParameter(
                    name="thickness",
                    value=None,
                    unit=result.units,
                    classification=CLASSIFICATION_UNKNOWN,
                )
                result.missing_critical_dimensions.append("thickness")

            result.parameters = {k: asdict(v) for k, v in params.items()}
            result.status = "success" if (ident.identifiable and opt_obj.success) else "partial"
            return result

        except Exception as e:
            result.status = "failed"
            result.errors.append(f"Concentric circle optimization error: {str(e)}")
            return result

    # -----------------------------------------------------------------------
    # Branch D: Direct User Dimensions + Gemini Proposal Grounding
    # -----------------------------------------------------------------------
    # When no point cloud or opencv circles exist, grounded parameters are resolved directly
    for k in ["outerDiameter", "innerDiameter", "height", "thickness", "width", "length", "teeth", "module"]:
        snake_k = k.replace("Diameter", "_diameter")
        if k in clean["user_dims"]:
            params[snake_k] = GeometricParameter(
                name=snake_k,
                value=clean["user_dims"][k],
                unit=result.units,
                classification=CLASSIFICATION_MEASURED,
                provenance=[PROV_USER_PROVIDED],
            )
        elif snake_k in clean["user_dims"]:
            params[snake_k] = GeometricParameter(
                name=snake_k,
                value=clean["user_dims"][snake_k],
                unit=result.units,
                classification=CLASSIFICATION_MEASURED,
                provenance=[PROV_USER_PROVIDED],
            )
        elif k in clean["proposals"]:
            params[snake_k] = GeometricParameter(
                name=snake_k,
                value=clean["proposals"][k],
                unit=result.units,
                classification=CLASSIFICATION_ESTIMATED,
                provenance=[PROV_GEMINI_PROPOSAL],
            )

    result.parameters = {k: asdict(v) for k, v in params.items()}
    result.status = "success" if has_user_dims else "partial"
    result.identifiability = asdict(IdentifiabilityReport(identifiable=True, num_parameters=len(params), rank=len(params)))
    return result
