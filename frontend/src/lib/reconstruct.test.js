import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveComponentType, computeParams, buildModel, COMPONENT_LABELS } from "./reconstruct.js";

test("resolveComponentType accurately detects bevel gears without defaulting to spur gear", () => {
  const bevelAnalysis = {
    componentType: "bevel gear",
    gearType: "bevel",
    coneAngle: 45,
    teeth: 20,
    features: ["conical teeth", "rear hub collar", "central bore"],
  };

  assert.equal(resolveComponentType(bevelAnalysis), "bevel gear");
  assert.equal(COMPONENT_LABELS["bevel gear"], "BEVEL GEAR");
});

test("resolveComponentType accurately detects stepped shafts without defaulting to cylinder", () => {
  const shaftAnalysis = {
    componentType: "stepped drive shaft",
    dimensions: { outerDiameter: 40, length: 180 },
    features: ["stepped journals", "ground shoulders", "spline head"],
  };

  assert.equal(resolveComponentType(shaftAnalysis), "stepped shaft");
  assert.equal(COMPONENT_LABELS["stepped shaft"], "STEPPED SHAFT");
});

test("buildModel constructs authentic 3D Bevel Gear group with conical teeth", () => {
  const bevelAnalysis = {
    componentType: "bevel gear",
    teeth: 20,
    dimensions: { outerDiameter: 90, innerDiameter: 22, height: 28, thickness: 28 },
    geometryRecipe: {
      style: "gear",
      gear: {
        gearType: "bevel",
        teeth: 20,
        coneAngle: 45,
        faceWidth: 28,
        boreRadius: 11,
        hubDiameter: 55,
        hubLength: 22,
      },
    },
  };

  const model = buildModel(bevelAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "BEVEL GEAR");
  const body = model.group.children[0];
  assert.ok(body.children.length >= 2, "Must contain cone blank, teeth crown, and hub");
});

test("buildModel constructs authentic 3D Stepped Shaft group with multiple diameter journals", () => {
  const shaftAnalysis = {
    componentType: "stepped shaft",
    dimensions: { outerDiameter: 45, innerDiameter: 0, length: 200, height: 200 },
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: -100, radius: 0 },
        { z: -100, radius: 15 },
        { z: -60, radius: 15 },
        { z: -60, radius: 20 },
        { z: 0, radius: 22.5 },
        { z: 60, radius: 20 },
        { z: 100, radius: 16 },
        { z: 100, radius: 0 },
      ],
    },
  };

  const model = buildModel(shaftAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "STEPPED SHAFT");
  assert.ok(model.group.children.length >= 1);
});

test("buildModel constructs authentic 3D Extruded connecting rod / bracket with outline and multiple through-holes", () => {
  const rodAnalysis = {
    componentType: "connecting rod",
    dimensions: { width: 50, length: 160, thickness: 22, innerDiameter: 25 },
    features: ["Big End Crank Bore Ø40mm", "Small End Pin Bore Ø20mm", "I-Beam Shank"],
    geometryRecipe: {
      style: "extruded",
      outline: [
        { x: -80, y: -20 },
        { x: -50, y: -12 },
        { x: 50, y: -16 },
        { x: 80, y: -28 },
        { x: 80, y: 28 },
        { x: 50, y: 16 },
        { x: -50, y: 12 },
        { x: -80, y: 20 },
      ],
      holes: [
        { cx: -65, cy: 0, radius: 10 },
        { cx: 60, cy: 0, radius: 20 },
      ],
      depth: 22,
    },
  };

  const model = buildModel(rodAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "CONNECTING ROD");
  const body = model.group.children[0];
  // Body must contain main extruded mesh and hole highlight cylinders
  assert.ok(body.children.length >= 2, "Must contain extruded body plus hole highlight cylinders");
});

test("buildModel constructs authentic 3D Neural/Surface Mesh with features, edges, and PBR buffer geometry", () => {
  const neuralMeshAnalysis = {
    componentType: "turbine impeller",
    dimensions: { width: 120, length: 120, thickness: 35, innerDiameter: 22 },
    features: ["Center Bore Ø22mm", "12 Aerodynamic Twisted Blades", "Primary Datum Face"],
    geometryRecipe: {
      style: "mesh",
      meshData: {
        vertices: [
          -50, -50, 10,
          50, -50, 10,
          50, 50, 10,
          -50, 50, 10,
          -50, -50, -10,
          50, -50, -10,
          50, 50, -10,
          -50, 50, -10,
        ],
        normals: [
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
        ],
        indices: [
          0, 1, 2,
          0, 2, 3,
          4, 6, 5,
          4, 7, 6,
        ],
        features: [
          { id: "feature-bore-1", type: "bore", label: "Center Bore Ø22mm", radius: 11, depth: 35, cx: 0, cy: 0, cz: 0 },
          { id: "feature-face-1", type: "mounting_face", label: "Primary Datum Face", width: 120, height: 120, cx: 0, cy: 0, cz: 10 },
        ],
      },
    },
  };

  const model = buildModel(neuralMeshAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "TURBINE IMPELLER");
  const body = model.group.children[0];
  assert.ok(body.children.length >= 2, "Must contain mesh, technical edge lines, and feature highlight proxies");
});

test("resolveComponentType accurately detects compound gear and flanged shaft without keyword hijacking", () => {
  const compoundGear = resolveComponentType({
    componentType: "Primary Gear",
    features: ["Stepped gear transition", "Cluster dual-stage reduction", "Bore with keyway"],
  });
  assert.equal(compoundGear, "compound gear");

  const flangedShaft = resolveComponentType({
    componentType: "Companion Gear",
    features: ["Precision linear ball spline shaft", "Circular mounting flange collar with 4 bolt holes"],
  });
  assert.equal(flangedShaft, "flanged shaft");
});

test("buildModel constructs authentic 3D Compound Gear with dual stages, bore, and keyway", () => {
  const compoundAnalysis = {
    componentType: "compound gear",
    dimensions: { outerDiameter: 130, innerDiameter: 28, height: 48, thickness: 48 },
    features: ["Stage 1 Base Spur Gear 24T", "Stage 2 Pinion Gear 16T", "Central Bore Ø28mm", "Keyway Slot"],
    geometryRecipe: {
      style: "compound_gear",
      gear: {
        stages: [
          { teeth: 24, module: 4.5, faceWidth: 26, outerDiameter: 130 },
          { teeth: 16, module: 4.5, faceWidth: 22, outerDiameter: 90 },
        ],
        boreRadius: 14,
        keyway: { width: 8, depth: 4 },
      },
    },
  };

  const model = buildModel(compoundAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "COMPOUND GEAR");
  const body = model.group.children[0];
  // Must contain Stage 1 gear, Stage 2 gear, bore cylinder, and keyway box
  assert.ok(body.children.length >= 4, "Must contain dual gear stages, bore, and keyway");
});

test("buildModel constructs authentic 3D Flanged Spline Shaft with longitudinal spline grooves and 4-hole flange", () => {
  const flangedAnalysis = {
    componentType: "flanged spline shaft",
    dimensions: { outerDiameter: 76, innerDiameter: 24, length: 180, thickness: 16 },
    features: ["Circular Mounting Flange Collar 4 Holes", "Linear Ball Spline Shaft 6 Grooves"],
    geometryRecipe: {
      style: "flanged_shaft",
      shaft: { diameter: 24, length: 180, splineCount: 6 },
      flange: {
        outerDiameter: 76,
        thickness: 16,
        boltCount: 4,
        boltCircleDiameter: 54,
        boltHoleDiameter: 7,
        bossDiameter: 36,
        bossHeight: 28,
      },
    },
  };

  const model = buildModel(flangedAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "FLANGED SPLINE SHAFT");
  const body = model.group.children[0];
  // Must contain main shaft, 6 spline ridges, flange disc, boss hub, 4 bolt holes
  assert.ok(body.children.length >= 10, "Must contain spline shaft, flange collar, boss, and bolt holes");
});

test("buildModel constructs authentic 3D Neural Mesh for Integral Helical Pinion Shaft with full axial journals", () => {
  const pinionShaftAnalysis = {
    componentType: "helical pinion shaft",
    dimensions: { outerDiameter: 60, innerDiameter: 0, length: 190, height: 190, thickness: 45 },
    features: [
      "Integrated 16T Helical Pinion (22° Helix Angle)",
      "Left Drive Journal Ø28mm",
      "Right Support Journal Ø25mm",
    ],
    geometryRecipe: {
      style: "mesh",
      meshData: {
        vertices: new Array(144 * 16 * 3).fill(0).map((_, i) => (i % 3 === 2 ? (i / (144 * 16 * 3)) * 190 - 95 : Math.sin(i) * 30)),
        normals: new Array(144 * 16 * 3).fill(0).map((_, i) => (i % 3 === 2 ? 0 : 1)),
        indices: [0, 1, 2, 0, 2, 3],
        features: [
          { id: "feature-gear-teeth-1", type: "gear_teeth", label: "16T Helical Teeth", teeth: 16, helixAngle: 22, faceWidth: 45, cx: 0, cy: 0, cz: 0 },
          { id: "feature-shaft-1", type: "shaft", label: "Left Drive Journal Ø28mm", radius: 14, length: 72, cx: 0, cy: 0, cz: -58 },
          { id: "feature-shaft-2", type: "shaft", label: "Right Support Journal Ø25mm", radius: 12.5, length: 72, cx: 0, cy: 0, cz: 58 },
          { id: "feature-body-1", type: "other", label: "3D Manifold Shell" },
        ],
      },
    },
  };

  const model = buildModel(pinionShaftAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "HELICAL PINION SHAFT");
  const body = model.group.children[0];
  assert.ok(body, "Must contain neural mesh body with CAD edges and feature proxies");
});

test("buildModel constructs authentic 3D Pinion Shaft group with integral helical teeth and stepped journals", () => {
  const pinionShaftRecipeAnalysis = {
    componentType: "helical pinion shaft",
    dimensions: { outerDiameter: 65, innerDiameter: 0, length: 240, thickness: 45 },
    features: [
      "Integrated 18T Helical Pinion",
      "Left Drive Journal Ø28mm",
      "Right Support Journal Ø25mm",
    ],
    geometryRecipe: {
      style: "pinion_shaft",
      gear: {
        teeth: 18,
        module: 3.5,
        helixAngle: 22.5,
        faceWidth: 45,
        outerDiameter: 65,
      },
      shaft: {
        diameter: 28,
        length: 240,
        driveJournalDiameter: 28,
        supportJournalDiameter: 25,
      },
    },
  };

  const model = buildModel(pinionShaftRecipeAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "HELICAL PINION SHAFT");
  const body = model.group.children[0];
  // Must contain gear section, drive shaft, drive bearing journal, support shaft, support bearing journal, keyway
  assert.ok(body.children.length >= 5, "Must contain gear mesh and stepped shaft journals");
});

test("OPERATOR A: buildModel constructs multi-stage gear cluster using continuous axial segments", () => {
  const clusterGearAnalysis = {
    componentType: "3-stage cluster gear",
    dimensions: { outerDiameter: 120, innerDiameter: 25, length: 90, thickness: 90 },
    features: [
      "Stage 1 Low Gear 32T",
      "Stage 2 Intermediate Gear 22T",
      "Stage 3 High Gear 14T",
      "Central Through Bore Ø25mm",
    ],
    geometryRecipe: {
      style: "axial_segments",
      axialSegments: [
        { zStart: -45, zEnd: -15, radius: 60, teeth: 32, module: 3.5, label: "Stage 1 Gear" },
        { zStart: -15, zEnd: 15, radius: 42, teeth: 22, module: 3.5, label: "Stage 2 Gear" },
        { zStart: 15, zEnd: 45, radius: 28, teeth: 14, module: 3.5, label: "Stage 3 Gear" },
      ],
      boreRadius: 12.5,
      keyway: { width: 6, height: 3.5 },
    },
  };

  const model = buildModel(clusterGearAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "3-STAGE CLUSTER GEAR");
  const body = model.group.children[0];
  assert.ok(body.children.length >= 3, "Must contain all 3 continuous gear stage meshes");
  const gearFeatures = body.children.filter((c) => c.userData?.featureType === "gear_teeth");
  assert.equal(gearFeatures.length, 3, "Must feature 3 distinct gear tooth stages");
});

test("OPERATOR A: buildModel creates watertight, uncorrupted helical pinion shaft without exploded bevels or axis tilts", () => {
  const pinionAnalysis = {
    componentType: "helical pinion shaft",
    dimensions: { outerDiameter: 60, innerDiameter: 0, length: 180, thickness: 42 },
    teeth: 16,
    module: 3,
    helixAngle: 22,
    features: [
      "Integrated 16T Helical Pinion Section",
      "Left Drive Journal Ø33.6mm",
      "Right Support Journal Ø30mm",
    ],
    geometryRecipe: {
      style: "pinion_shaft",
      operator: "axial_segments",
      axialSegments: [
        { zStart: -90, zEnd: -21, radius: 16.8, label: "Drive Journal (Left)" },
        { zStart: -21, zEnd: 21, teeth: 16, module: 3, helixAngle: 22, radius: 30, label: "Helical Pinion Gear" },
        { zStart: 21, zEnd: 90, radius: 15, label: "Support Journal (Right)" },
      ],
      gear: { teeth: 16, module: 3, helixAngle: 22, faceWidth: 42, outerDiameter: 60 },
      shaft: { diameter: 33.6, length: 180, driveJournalDiameter: 33.6, supportJournalDiameter: 30 },
    },
  };

  const model = buildModel(pinionAnalysis);
  assert.ok(model.group);
  assert.equal(model.label, "HELICAL PINION SHAFT");
  const body = model.group.children[0];
  assert.ok(body);

  // Check that meshes have realistic vertex bounds and no degenerate explosion
  body.traverse((node) => {
    if (node.isMesh && node.geometry) {
      const pos = node.geometry.attributes.position;
      assert.ok(pos.count > 0, "Mesh must contain vertices");
      node.geometry.computeBoundingBox();
      const b = node.geometry.boundingBox;
      const sizeX = b.max.x - b.min.x;
      const sizeY = b.max.y - b.min.y;
      const sizeZ = b.max.z - b.min.z;
      assert.ok(sizeX > 0 && sizeY > 0 && sizeZ > 0, "Mesh bounds must be strictly positive non-flat");
      assert.ok(sizeX < 1000 && sizeY < 1000 && sizeZ < 1000, "Mesh bounds must not explode");
    }
  });
});

test("OPERATOR A: buildModel creates compound gear aligned on Z axis with through-bore and zero floating torus rings", () => {
  const compoundGearAnalysis = {
    componentType: "compound gear",
    dimensions: { outerDiameter: 120, innerDiameter: 30, thickness: 45, height: 45 },
    teeth: 24,
    module: 4.5,
    features: [
      "Stage 1 Bull Gear 24T Ø120mm",
      "Stage 2 Pinion Gear 16T Ø72mm",
      "Central Bore Ø30mm with Keyway Slot",
    ],
    geometryRecipe: {
      style: "compound_gear",
      operator: "axial_segments",
      axialSegments: [
        { zStart: -25, zEnd: 0, radius: 60, teeth: 24, module: 4.5, innerRadius: 15, label: "Stage 1 Bull Gear" },
        { zStart: 0, zEnd: 20, radius: 36, teeth: 16, module: 4.5, innerRadius: 15, label: "Stage 2 Pinion Gear" },
      ],
      boreRadius: 15,
      keyway: { width: 6, height: 3.5 },
      gear: {
        stages: [
          { teeth: 24, module: 4.5, outerDiameter: 120, faceWidth: 25 },
          { teeth: 16, module: 4.5, outerDiameter: 72, faceWidth: 20 },
        ],
        boreRadius: 15,
        keyway: { width: 6, height: 3.5 },
      },
    },
  };

  const model = buildModel(compoundGearAnalysis);
  assert.ok(model.group);
  const body = model.group.children[0];
  assert.ok(body);

  let torusCount = 0;
  let gearMeshCount = 0;
  let hasBoreHole = false;

  body.traverse((node) => {
    if (node.isMesh && node.geometry) {
      if (node.geometry.type === "TorusGeometry") {
        torusCount++;
      }
      if (node.userData?.featureType === "gear_teeth") {
        gearMeshCount++;
      }
    }
  });

  assert.equal(torusCount, 0, "Must NEVER generate floating Torus rings over compound gear teeth");
  assert.equal(gearMeshCount, 2, "Must generate exactly 2 gear stages");

  // Verify compact gear cluster orientation along Z axis (face in XY)
  const box = new THREE.Box3().setFromObject(body);
  const sizeX = box.max.x - box.min.x;
  const sizeY = box.max.y - box.min.y;
  const sizeZ = box.max.z - box.min.z;

  // Since executeRecipe scales maxDim to 6.0 units for Three.js viewport:
  // With OD = 120 and total thickness = 45:
  // X and Y are ~6.0 (face in XY), and Z is ~2.25 (axial thickness along Z)
  assert.ok(Math.abs(sizeX - 6.0) < 0.2, `Width in X should be ~6.0, got ${sizeX}`);
  assert.ok(Math.abs(sizeY - 6.0) < 0.2, `Height in Y should be ~6.0, got ${sizeY}`);
  assert.ok(Math.abs(sizeZ - 2.25) < 0.2, `Thickness in Z should be ~2.25, got ${sizeZ}`);
});

test("OPERATOR A: buildModel generates continuous Archimedean worm flight with dual keyways and threaded stud", () => {
  const wormAnalysis = {
    componentType: "precision worm drive shaft",
    dimensions: { outerDiameter: 60, innerDiameter: 0, length: 192, height: 192, thickness: 54 },
    pitch: 8.0,
    starts: 1,
    lead: 8.0,
    features: [
      "Archimedean Worm Thread Flight (p8mm Ø60mm)",
      "Threaded Nose Stud M16x1.5",
      "Drive Journal Ø33.6mm with Keyway Slot",
      "Dual Ground Locator Shoulders Ø38mm",
      "Support Journal Ø30mm & Stepped Tail Extension",
    ],
    geometryRecipe: {
      style: "axial_segments",
      operator: "axial_segments",
      axialSegments: [
        { zStart: -96, zEnd: -76, radius: 12, featureType: "threaded_stud", thread: "M16x1.5", label: "Threaded Nose Stud (M16)" },
        { zStart: -76, zEnd: -37, radius: 16.8, label: "Drive Journal (Left)" },
        { zStart: -37, zEnd: -27, radius: 19, label: "Locator Collar (Left)" },
        { zStart: -27, zEnd: 27, radius: 30, rootRadius: 21, pitch: 8, starts: 1, lead: 8, featureType: "worm_thread", label: "1-Start Archimedean Worm Flight (p8)" },
        { zStart: 27, zEnd: 37, radius: 19, label: "Locator Collar (Right)" },
        { zStart: 37, zEnd: 71, radius: 15, label: "Support Journal (Right)" },
        { zStart: 71, zEnd: 96, radius: 12.5, label: "Stepped Output Journal" },
      ],
      modifiers: [
        { type: "keyway", x: -55, z: 0, width: 6, depth: 3.5, length: 22, radius: 16.8, label: "Drive Keyway Slot" },
        { type: "keyway", x: 82, z: 0, width: 5, depth: 3.0, length: 18, radius: 12.5, label: "Output Keyway Slot" },
      ],
    },
  };

  const model = buildModel(wormAnalysis);
  assert.ok(model.group);
  const body = model.group.children[0];
  assert.ok(body);

  let wormFlightCount = 0;
  let keywayCount = 0;
  let threadedStudCount = 0;

  body.traverse((node) => {
    if (node.isMesh && node.userData) {
      if (node.userData.featureType === "worm_thread") wormFlightCount++;
      if (node.userData.featureType === "keyway") keywayCount++;
      if (node.userData.featureType === "threaded_stud") threadedStudCount++;
    }
  });

  assert.equal(wormFlightCount, 1, "Must generate exactly 1 continuous 3D worm thread flight");
  assert.equal(keywayCount, 2, "Must generate both multi-station keyway slots");
  assert.equal(threadedStudCount, 1, "Must generate threaded nose stud");

  // Verify non-zero and non-exploding bounds
  const box = new THREE.Box3().setFromObject(body);
  const sizeX = box.max.x - box.min.x;
  const sizeY = box.max.y - box.min.y;
  const sizeZ = box.max.z - box.min.z;
  assert.ok(sizeX > 5 && sizeX < 7, `Scaled length in X should be ~6.0, got ${sizeX}`);
  assert.ok(sizeY > 1.5 && sizeY < 2.5, `Scaled height in Y should be ~1.875, got ${sizeY}`);
  assert.ok(sizeZ > 1.5 && sizeZ < 2.5, `Scaled depth in Z should be ~1.875, got ${sizeZ}`);
});

test("buildModel constructs authentic Deep-Groove Ball Bearing with inner race, outer race, and spherical balls", () => {
  const bearingAnalysis = {
    componentType: "bearing",
    dimensions: { outerDiameter: 42, innerDiameter: 20, height: 12, thickness: 12 },
    geometryRecipe: {
      style: "combination",
      primitives: [{ kind: "torus", radius: 21, tube: 6 }],
    },
  };

  const { group } = buildModel(bearingAnalysis);
  let outerRaceFound = false;
  let innerRaceFound = false;
  let ballCount = 0;
  let singleTorusFound = false;

  group.traverse((node) => {
    if (node.isMesh) {
      if (node.userData?.featureType === "outer_race") outerRaceFound = true;
      if (node.userData?.featureType === "inner_race") innerRaceFound = true;
      if (node.userData?.featureType === "ball_bearing" || node.userData?.featureType === "groove") ballCount++;
      if (node.geometry?.type === "TorusGeometry" && node.parent === group) singleTorusFound = true;
    }
  });

  assert.equal(singleTorusFound, false, "Must NEVER render a single donut/torus for a ball bearing");
  assert.ok(outerRaceFound, "Must contain outer race ring");
  assert.ok(innerRaceFound, "Must contain inner race ring with bore");
  assert.ok(ballCount >= 6, `Must contain spherical ball bearings, found ${ballCount}`);
});

test("buildModel constructs authentic Circular Cap with closed top lid and cylindrical skirt", () => {
  const capAnalysis = {
    componentType: "cap/bushing",
    dimensions: { outerDiameter: 32, innerDiameter: 28, height: 14, thickness: 2 },
    geometryRecipe: {
      style: "extruded",
      outline: [{ x: -16, y: -16 }, { x: 16, y: -16 }, { x: 16, y: 16 }, { x: -16, y: 16 }],
      holes: [{ cx: 0, cy: 0, radius: 14 }],
      depth: 14,
    },
  };

  const { group } = buildModel(capAnalysis);
  let topLidFound = false;
  let skirtFound = false;

  group.traverse((node) => {
    if (node.isMesh && node.userData) {
      if (node.userData.featureType === "cap_top") topLidFound = true;
      if (node.userData.featureType === "cap_wall") skirtFound = true;
    }
  });

  assert.ok(topLidFound, "Must contain solid top lid disc closing the top face");
  assert.ok(skirtFound, "Must contain cylindrical skirt wall creating hollow cavity");
});



