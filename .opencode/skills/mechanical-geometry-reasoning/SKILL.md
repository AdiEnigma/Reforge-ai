---
name: mechanical-geometry-reasoning
description: Implement mechanical geometric feature understanding for any component type. Covers cylinders, cones, spheres, planar surfaces, extrusions, revolutions, holes, bores, slots, grooves, fillets, chamfers, gear teeth, splines, patterns, symmetry, and coordinate systems. Use JSON representation distinguishing known, estimated, and unknown parameters.
---

# Mechanical Geometry Reasoning

## Purpose

Enable AI agents to implement the core mechanical engineering knowledge needed to interpret visual evidence from component photographs and convert it into structured geometric parameters for CAD generation.

## When to use

- When processing component images to extract geometric features.
- When building the feature extraction pipeline (OpenCV, SAM2, Gemini integration).
- When implementing geometric parameter estimation from image evidence.
- When designing the feature-based JSON representation for CAD recipes.
- When adding new geometric feature types to the system.

## Project context

The ReForge AI system must understand mechanical components regardless of their type. This requires recognizing geometric primitives (cylinders, cones, spheres, boxes) and their relationships (holes, bores, slots, grooves, fillets, chamfers), as well as patterns (circular, linear, symmetry), coordinate systems, and feature dependencies.

### Key geometric concepts

**Basic primitives:**
- Cylinders (solid or hollow)
- Cones (solid or hollow)
- Spheres (solid or hollow)
- Boxes/rectangular prisms
- Toroids

**Features:**
- Holes, bores, through-holes, blind holes
- Slots, grooves, keyways
- Threads (internal/external)
- Fillets (rounded edges)
- Chamfers (beveled edges)
- Ribs, bosses, connectors
- Cavities, pockets

**Patterns:**
- Circular patterns (bolt circles, gear teeth)
- Linear patterns (bolt holes, ribs)
- Symmetry (bilateral, rotational)

**Coordinate systems:**
- Global coordinate system (X, Y, Z axes)
- Local feature coordinate systems
- Datum planes and axes

### Feature representation

Features must be represented with these properties:

```json
{
  "features": [
    {
      "id": "feature-001",
      "type": "cylinder",
      "operation": "additive", // additive/subtractive/finish
      "parameters": {
        "radius": 5.0,
        "height": 10.0,
        "tolerance": 0.1
      },
      "position": { "x": 0.0, "y": 0.0, "z": 0.0 },
      "orientation": { "axis": [0.0, 0.0, 1.0], "angleDeg": 0.0 },
      "units": "mm",
      "confidence": 0.95,
      "provenance": "gemini|opencv|sam2",
      "isEstimated": false,
      "isUnknown": false,
      "uncertainties": ["diameter", "position"],
      "dependencies": [],
      "metadata": {
        "label": "Shaft",
        "description": "Main drive shaft",
        "material": "steel"
      }
    }
  ]
}
```

### Dimension classification

**Known dimensions:**
- Dimensions explicitly provided by the user
- Dimensions clearly visible in images with reliable measurement

**Estimated dimensions:**
- Dimensions inferred from visual evidence with uncertainty
- Dimensions derived from proportional relationships
- Dimensions calculated from feature constraints

**Unknown dimensions:**
- Dimensions not inferable from available evidence
- Dimensions that require user input
- Dimensions that are intentionally left open for design iteration

## Implementation guidelines

### 1. Feature type recognition

**Cylinders:**
- Detect circular cross-sections
- Measure diameter (known/estimated/unknown)
- Determine height/length
- Identify if hollow (bore)

**Cones:**
- Detect tapered shapes
- Measure base and tip diameters
- Determine height
- Identify if solid or hollow

**Spheres:**
- Detect spherical shapes
- Measure diameter
- Identify if solid or hollow

**Boxes:**
- Detect rectangular shapes
- Measure width, height, depth
- Identify orientation

**Holes/Bores:**
- Detect circular voids
- Measure diameter
- Determine depth (through/ blind)
- Identify center position

**Slots/Grooves:**
- Detect rectangular or curved voids
- Measure width, depth
- Identify orientation

**Threads:**
- Detect helical patterns
- Measure pitch, major diameter
- Identify handedness

**Fillets/Chamfers:**
- Detect edge treatments
- Measure radius (fillet) or angle (chamfer)
- Identify location

### 2. Pattern recognition

**Circular patterns:**
- Detect equally spaced features
- Calculate angular spacing
- Identify pattern center
- Count number of features

**Linear patterns:**
- Detect equally spaced features
- Calculate linear spacing
- Identify pattern axis
- Count number of features

**Symmetry:**
- Detect bilateral symmetry
- Detect rotational symmetry
- Identify symmetry plane/axis
- Determine order of rotational symmetry

### 3. Coordinate system handling

**Global coordinate system:**
- Define X, Y, Z axes
- Establish origin
- Define units (mm, inches)

**Local coordinate systems:**
- Define feature-specific coordinate systems
- Establish feature origin
- Define feature axes
- Transform between global and local coordinates

**Datum features:**
- Identify primary datum planes
- Identify secondary datum planes
- Identify datum axes

### 4. Feature relationships

**Dependencies:**
- Features that must be created before others
- Features that depend on other features
- Features that modify other features

**Constraints:**
- Geometric constraints (concentricity, parallelism, perpendicularity)
- Dimension constraints (equal, related)
- Positional constraints (coincident, tangent)

### 5. Uncertainty handling

**Confidence scores:**
- Gemini confidence scores (0.0-1.0)
- OpenCV feature confidence scores
- SAM2 segmentation confidence

**Uncertainty propagation:**
- Track uncertainty through the pipeline
- Propagate uncertainty to derived parameters
- Provide uncertainty bounds for estimated dimensions

### 6. JSON schema for features

```json
{
  "features": [
    {
      "id": "string",
      "type": "string", // from FEATURE_TYPES in frontend/src/lib/features.js
      "operation": "string", // additive/subtractive/finish
      "parameters": {
        "radius": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number },
        "height": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number },
        "diameter": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number },
        // other parameters as needed
      },
      "position": {
        "x": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number },
        "y": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number },
        "z": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number }
      },
      "orientation": {
        "axis": ["x", "y", "z"],
        "angleDeg": { "value": number, "known": boolean, "estimated": boolean, "uncertainty": number }
      },
      "units": "mm",
      "confidence": number,
      "provenance": "string",
      "isEstimated": boolean,
      "isUnknown": boolean,
      "uncertainties": ["string"],
      "dependencies": ["string"],
      "constraints": {
        "concentricity": ["feature-id"],
        "parallelism": ["feature-id"],
        "perpendicularity": ["feature-id"]
      },
      "metadata": {
        "label": "string",
        "description": "string",
        "material": "string",
        "surfaceFinish": "string"
      }
    }
  ]
}
```

## Best practices

### 1. Use existing feature types

The frontend already defines feature types in `frontend/src/lib/features.js`. Use these established types:

```javascript
const FEATURE_TYPES = {
  bore: { label: "Bore", priority: 1 },
  mounting_hole: { label: "Mounting Hole", priority: 2 },
  keyway: { label: "Keyway", priority: 3 },
  gear_teeth: { label: "Gear Teeth", priority: 4 },
  shoulder: { label: "Shoulder", priority: 5 },
  flange: { label: "Flange", priority: 6 },
  shaft: { label: "Shaft", priority: 7 },
  boss: { label: "Boss", priority: 8 },
  slot: { label: "Slot", priority: 9 },
  pocket: { label: "Pocket", priority: 10 },
  groove: { label: "Groove", priority: 11 },
  chamfer: { label: "Chamfer", priority: 12 },
  fillet: { label: "Fillet", priority: 13 },
  thread: { label: "Thread", priority: 14 },
  other: { label: "Other", priority: 15 }
};
```

### 2. Follow the existing feature normalization

Use the `normalizeFeatures()` function in `frontend/src/lib/features.js` to merge features from different sources (recipe, analysis, text) with proper priority handling.

### 3. Maintain feature priority

Features have priority levels that determine which source takes precedence when there are conflicts:

1. Recipe (user-defined)
2. Derived (from component type)
3. Analysis (from Gemini/OpenCV)

### 4. Use established feature schemas

The feature schema is defined in `python-engine/cad/feature_schema.py`. Use this schema for advanced feature recipes.

### 5. Handle edge cases

- Small components (less than 1% of image area) should be filtered out
- Ambiguous features should be flagged for user review
- Low confidence features should be marked as uncertain

## Common mistakes to avoid

### 1. Restricting to predefined component categories

The system should handle any mechanical component, not just gears, shafts, brackets, or bearings. Do not limit the feature recognition to predefined component types.

### 2. Fabricating dimensions

Never fabricate dimensions that cannot be inferred from available evidence. Mark dimensions as unknown when they cannot be determined.

### 3. Treating visual plausibility as engineering accuracy

A visually attractive Three.js model must not automatically be considered geometrically accurate. Always validate geometry against constraints.

### 4. Ignoring uncertainty

Always track and propagate uncertainty through the pipeline. Unknown dimensions must be clearly marked.

### 5. Overlooking coordinate systems

Always define coordinate systems for features. Global and local coordinate systems must be properly handled.

### 6. Breaking feature dependencies

Always respect feature dependencies. Features that depend on other features must be created in the correct order.

## Validation checklist

- [ ] Feature types are consistent with `frontend/src/lib/features.js`
- [ ] Feature parameters include known/estimated/unknown classification
- [ ] Uncertainty is properly tracked and propagated
- [ ] Feature dependencies are correctly specified
- [ ] Coordinate systems are properly defined
- [ ] Priority-based feature merging works correctly
- [ ] Feature schemas are consistent between frontend and backend
- [ ] Edge cases (small components, ambiguous features) are handled
- [ ] Low confidence features are properly flagged
- [ ] Feature relationships (constraints, dependencies) are preserved