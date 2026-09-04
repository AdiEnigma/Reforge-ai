import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as exporters from './exporters.js';

const mockAnalysis = {
  componentType: 'spur_gear',
  material: 'Structural Steel AISI 4140',
  dimensions: {
    outerDiameter: 120,
    innerDiameter: 30,
    thickness: 25,
    teeth: 24,
    module: 5,
    faceWidth: 25,
  },
  features: ['Central Bore 30mm', '24 Involute Gear Teeth', 'Keyway 8x4mm'],
  confidence: 0.94,
  uncertainties: [],
  geometryType: 'CYLINDRICAL_GEAR',
};

const mockMfgData = {
  process: {
    recommended: {
      name: 'CNC Gear Hobbing & Finish Turning',
      label: 'CNC Machining',
    },
  },
  cost: {
    low: 1200,
    high: 1800,
  },
};

describe('Engineering Exporter Suite', () => {
  it('generates valid STEP and IGES CAD files', () => {
    const step = exporters.exportSTEP(mockAnalysis);
    assert.ok(step.content.includes('ISO-10303-21'));
    assert.ok(step.content.includes('SPUR-GEAR') || step.content.includes('SPUR_GEAR'));
    assert.ok(step.filename.endsWith('.step'));

    const iges = exporters.exportIGES(mockAnalysis);
    assert.ok(iges.content.includes('REFORGE AI IGES'));
    assert.ok(iges.filename.endsWith('.iges'));
  });

  it('generates native CAD parametric definitions', () => {
    const sldprt = exporters.exportSolidWorksPart(mockAnalysis);
    assert.ok(sldprt.content.includes('SOLIDWORKS PART DEFINITION') || sldprt.content.includes('SolidWorks'));
    assert.ok(sldprt.filename.endsWith('.sldprt'));

    const f3d = exporters.exportFusion360(mockAnalysis);
    assert.ok(f3d.content.includes('AUTODESK FUSION 360') || f3d.content.includes('Fusion 360'));
    assert.ok(f3d.filename.endsWith('.f3d'));
  });

  it('generates standard 3D mesh files (STL, OBJ, GLTF)', () => {
    const stl = exporters.exportSTL(mockAnalysis);
    assert.ok(stl.content.includes('solid'));
    assert.ok(stl.content.includes('endsolid'));
    assert.ok(stl.filename.endsWith('.stl'));

    const obj = exporters.exportOBJ(mockAnalysis);
    assert.ok(obj.content.includes('# Wavefront OBJ'));
    assert.ok(obj.content.includes('v '));
    assert.ok(obj.content.includes('f '));
    assert.ok(obj.filename.endsWith('.obj'));

    const gltf = exporters.exportGLTF(mockAnalysis);
    assert.ok(gltf.content.includes('"asset":'));
    assert.ok(gltf.filename.endsWith('.gltf'));
  });

  it('generates 2D technical drawings (DXF, SVG)', () => {
    const dxf = exporters.exportDXF(mockAnalysis);
    assert.ok(dxf.content.includes('HEADER'));
    assert.ok(dxf.content.includes('ENTITIES'));
    assert.ok(dxf.filename.endsWith('.dxf'));

    const svg = exporters.exportDrawingSVG(mockAnalysis);
    assert.ok(svg.content.includes('<svg'));
    assert.ok(svg.content.includes('</svg>'));
    assert.ok(svg.filename.endsWith('.svg'));
  });

  it('generates CNC G-Code and toolpaths', () => {
    const gcode = exporters.exportGCode(mockAnalysis);
    assert.ok(gcode.content.includes('G90 G21 G17'));
    assert.ok(gcode.content.includes('M30'));
    assert.ok(gcode.filename.endsWith('.gcode'));
  });

  it('generates 3D scan point clouds (PLY, PTS, PCD)', () => {
    const ply = exporters.exportScanPLY(mockAnalysis);
    assert.ok(ply.content.includes('ply'));
    assert.ok(ply.content.includes('format ascii 1.0'));
    assert.ok(ply.filename.endsWith('.ply'));

    const pcd = exporters.exportScanPCD(mockAnalysis);
    assert.ok(pcd.content.includes('# .PCD v0.7'));
    assert.ok(pcd.filename.endsWith('.pcd'));
  });

  it('generates FEA simulation input decks (Abaqus INP, Nastran BDF, VTK)', () => {
    const inp = exporters.exportSimulationINP(mockAnalysis);
    assert.ok(inp.content.includes('*HEADING'));
    assert.ok(inp.content.includes('*MATERIAL'));
    assert.ok(inp.filename.endsWith('.inp'));

    const bdf = exporters.exportSimulationBDF(mockAnalysis);
    assert.ok(bdf.content.includes('NASTRAN BDF'));
    assert.ok(bdf.content.includes('MAT1'));
    assert.ok(bdf.filename.endsWith('.bdf'));

    const vtk = exporters.exportSimulationVTK(mockAnalysis);
    assert.ok(vtk.content.includes('# vtk DataFile Version 3.0'));
    assert.ok(vtk.filename.endsWith('.vtk'));
  });

  it('generates structured material databases (JSON, CSV, XML, YAML)', () => {
    const json = exporters.exportMaterialJSON(mockAnalysis);
    assert.doesNotThrow(() => JSON.parse(json.content));
    assert.ok(json.filename.endsWith('.json'));

    const csv = exporters.exportMaterialCSV(mockAnalysis);
    assert.ok(csv.content.includes('Property,Value,Unit,Provenance'));
    assert.ok(csv.filename.endsWith('.csv'));
  });

  it('generates Laser Cutting and BIM formats (DXF laser, IFC)', () => {
    const laserDxf = exporters.exportLaserDXF(mockAnalysis);
    assert.ok(laserDxf.content.includes('HEADER'));
    assert.ok(laserDxf.filename.endsWith('.dxf'));

    const ifc = exporters.exportIFC(mockAnalysis);
    assert.ok(ifc.content.includes('ISO-10303-21;'));
    assert.ok(ifc.content.includes('IFC4'));
    assert.ok(ifc.filename.endsWith('.ifc'));
  });
});
