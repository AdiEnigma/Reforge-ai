/**
 * universal-composition-graph.js
 * Universal Declarative CAD Composition Graph (B-Rep AST) for ReForge AI.
 *
 * Implements the non-categorical, feature-driven mechanical architecture:
 * Replaces hardcoded taxonomic classifiers with a composition graph of:
 * 1. Carrier Bodies:
 *    - Revolved profile (continuous axial stages, stepped journals, collars, necks)
 *    - Extruded planar profile (brackets, links, forks, mounting arms, housings)
 *    - Swept trajectory (curved passages, ducts, organic junctions)
 * 2. Modifiers:
 *    - Subtractive: through/blind bores, keyways, bolt circles, cross-holes, slots, grooves
 *    - Additive: bosses, ears, ribs, flanges, collars, lugs
 *    - Functional Tooth Cuts / Helical Flights:
 *        * Archimedean worm flights (pitch, starts, lead, root/crest envelope)
 *        * Involute gear teeth (spur, helical, bevel with cone angle, face width, module)
 *        * Splines (involute or straight-sided axial drive splines)
 *        * Machine threads (standard metric/imperial pitches)
 * 3. Junctions:
 *    - Coaxial junctions (stacked axial stages, transitions, concentric steps)
 *    - Perpendicular / Orthogonal junctions (shift fork arms, crank pins, transverse bores)
 *    - Branched / Off-axis junctions (mounting ears, bracket arms, flanges)
 * 4. Provenance & Confidence on Every Parameter:
 *    - Status: MEASURED (calibrated / user-ground truth) vs ESTIMATED vs UNKNOWN
 *    - Continuous confidence score [0.0, 1.0]
 */

export const AST_NODE_TYPES = Object.freeze({
  CARRIER_REVOLVED: 'carrier_revolved',
  CARRIER_EXTRUDED: 'carrier_extruded',
  CARRIER_SWEPT: 'carrier_swept',
  MODIFIER_BORE: 'modifier_bore',
  MODIFIER_KEYWAY: 'modifier_keyway',
  MODIFIER_BOLT_PATTERN: 'modifier_bolt_pattern',
  MODIFIER_GROOVE: 'modifier_groove',
  MODIFIER_SLOT: 'modifier_slot',
  MODIFIER_WORM_FLIGHT: 'modifier_worm_flight',
  MODIFIER_GEAR_TEETH: 'modifier_gear_teeth',
  MODIFIER_SPLINE: 'modifier_spline',
  MODIFIER_THREAD: 'modifier_thread',
  MODIFIER_BOSS: 'modifier_boss',
  JUNCTION_COAXIAL: 'junction_coaxial',
  JUNCTION_PERPENDICULAR: 'junction_perpendicular',
  JUNCTION_BRANCHED: 'junction_branched',
});

/**
 * Builds a universal mechanical AST node representing a carrier body.
 */
export function createCarrierNode({
  id = 'carrier_main',
  type = AST_NODE_TYPES.CARRIER_REVOLVED,
  frame = { origin: [0, 0, 0], axis: [0, 0, 1] },
  geometry = {},
  label = 'Main Carrier Body',
}) {
  return {
    id,
    nodeType: 'carrier',
    carrierType: type,
    frame,
    geometry,
    label,
    modifiers: [],
    junctions: [],
  };
}

/**
 * Attaches a modifier feature to a carrier node.
 */
export function attachModifier(carrierNode, {
  id,
  type,
  parameters = {},
  location = { position: [0, 0, 0], orientation: [0, 0, 1] },
  provenance = { status: 'ESTIMATED', confidence: 0.8 },
  label = '',
}) {
  if (!carrierNode || !Array.isArray(carrierNode.modifiers)) {
    throw new Error('Invalid carrier node provided to attachModifier');
  }
  const modifier = {
    id: id || `modifier_${carrierNode.modifiers.length + 1}`,
    type,
    parameters,
    location,
    provenance,
    label: label || type,
  };
  carrierNode.modifiers.push(modifier);
  return modifier;
}

/**
 * Attaches a branched or perpendicular junction connecting two bodies.
 */
export function attachJunction(parentCarrier, childCarrier, {
  junctionType = AST_NODE_TYPES.JUNCTION_PERPENDICULAR,
  attachmentPoint = [0, 0, 0],
  normal = [1, 0, 0],
  filletRadius = 0,
  label = 'Junction Interface',
}) {
  const junction = {
    junctionType,
    parentCarrierId: parentCarrier.id,
    childCarrierId: childCarrier.id,
    attachmentPoint,
    normal,
    filletRadius,
    label,
  };
  parentCarrier.junctions.push(junction);
  return junction;
}

/**
 * Compiles a Universal Composition Graph into a unified, clean geometry recipe
 * fully supported by CadQuery and the Three.js viewport execution engine.
 */
export function compileCompositionGraphToRecipe(graph) {
  if (!graph || !Array.isArray(graph.carriers) || graph.carriers.length === 0) {
    return null;
  }

  const primaryCarrier = graph.carriers[0];

  // Case 1: Revolved Carrier (e.g. multi-stage transmission shafts, worm shafts, stepped spindles)
  if (primaryCarrier.carrierType === AST_NODE_TYPES.CARRIER_REVOLVED) {
    const axialStages = primaryCarrier.geometry.stages || [];
    const axialSegments = [];

    for (const stage of axialStages) {
      const seg = {
        zStart: stage.zStart,
        zEnd: stage.zEnd,
        radius: stage.radius,
        innerRadius: stage.innerRadius || 0,
        label: stage.label || 'Shaft Stage',
      };
      if (stage.featureType) seg.featureType = stage.featureType;
      if (stage.pitch) seg.pitch = stage.pitch;
      if (stage.starts) seg.starts = stage.starts;
      if (stage.lead) seg.lead = stage.lead;
      if (stage.rootRadius) seg.rootRadius = stage.rootRadius;
      if (stage.teeth) seg.teeth = stage.teeth;
      if (stage.module) seg.module = stage.module;
      if (stage.helixAngle) seg.helixAngle = stage.helixAngle;
      if (stage.splineCount) seg.splineCount = stage.splineCount;
      if (stage.thread) seg.thread = stage.thread;
      axialSegments.push(seg);
    }

    // Fold modifiers into recipe
    const modifiers = [];
    let boreRadius = 0;
    let keyway = null;

    for (const mod of primaryCarrier.modifiers) {
      if (mod.type === AST_NODE_TYPES.MODIFIER_BORE) {
        boreRadius = Math.max(boreRadius, (mod.parameters.diameter || 0) / 2);
      } else if (mod.type === AST_NODE_TYPES.MODIFIER_KEYWAY) {
        modifiers.push({
          type: 'keyway',
          x: mod.location.position[0] || 0,
          z: mod.location.position[2] || 0,
          width: mod.parameters.width || 6,
          depth: mod.parameters.depth || 3.5,
          length: mod.parameters.length || 20,
          radius: mod.parameters.journalRadius || 15,
          label: mod.label || 'Keyway Slot',
        });
        if (!keyway) {
          keyway = { width: mod.parameters.width || 6, height: mod.parameters.depth || 3.5 };
        }
      } else if (mod.type === AST_NODE_TYPES.MODIFIER_BOLT_PATTERN) {
        modifiers.push({
          type: 'bolt_pattern',
          count: mod.parameters.count || 4,
          boltCircleDiameter: mod.parameters.boltCircleDiameter || 50,
          holeDiameter: mod.parameters.holeDiameter || 8,
          depth: mod.parameters.depth || 15,
          label: mod.label || 'Bolt Pattern',
        });
      }
    }

    return {
      style: 'axial_segments',
      operator: 'axial_segments',
      axialSegments,
      modifiers,
      boreRadius,
      keyway,
      compositionGraph: graph,
    };
  }

  // Case 2: Extruded Carrier (e.g. brackets, shift forks, links, housings)
  if (primaryCarrier.carrierType === AST_NODE_TYPES.CARRIER_EXTRUDED) {
    const outline = primaryCarrier.geometry.outline || [];
    const depth = primaryCarrier.geometry.depth || 20;
    const holes = [];

    for (const mod of primaryCarrier.modifiers) {
      if (mod.type === AST_NODE_TYPES.MODIFIER_BORE) {
        holes.push({
          cx: mod.location.position[0] || 0,
          cy: mod.location.position[1] || 0,
          radius: (mod.parameters.diameter || 0) / 2,
        });
      } else if (mod.type === AST_NODE_TYPES.MODIFIER_BOLT_PATTERN) {
        const count = mod.parameters.count || 4;
        const bcd = mod.parameters.boltCircleDiameter || 50;
        const r = (mod.parameters.holeDiameter || 8) / 2;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          holes.push({
            cx: Math.round(Math.cos(a) * (bcd / 2) * 100) / 100,
            cy: Math.round(Math.sin(a) * (bcd / 2) * 100) / 100,
            radius: r,
          });
        }
      }
    }

    return {
      style: 'extruded',
      outline,
      holes,
      depth,
      compositionGraph: graph,
    };
  }

  return null;
}
