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

const originalFetch = globalThis.fetch;

function stubFetch() {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const format = JSON.parse(init.body).format;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) =>
          String(name).toLowerCase() === 'content-disposition'
            ? `attachment; filename="spur-gear.${format}"`
            : null,
      },
      blob: async () => new Blob(['ISO-10303-21;']),
    };
  };
  return requests;
}

describe('Engineering Exporter Suite', () => {
  it('requests real CAD exports from the backend (STEP, IGES, STL, OBJ)', async () => {
    const requests = stubFetch();
    try {
      const step = await exporters.exportSTEP(mockAnalysis);
      assert.equal(requests[0].url, '/api/cad/export');
      assert.equal(requests[0].body.format, 'step');
      assert.equal(requests[0].body.analysis.dimensions.outerDiameter, 120);
      assert.ok(step.filename.endsWith('.step'));

      const iges = await exporters.exportIGES(mockAnalysis);
      assert.equal(requests[1].body.format, 'iges');
      assert.ok(iges.filename.endsWith('.iges'));

      const stl = await exporters.exportSTL(mockAnalysis);
      assert.equal(requests[2].body.format, 'stl');
      assert.ok(stl.filename.endsWith('.stl'));

      const obj = await exporters.exportOBJ(mockAnalysis);
      assert.equal(requests[3].body.format, 'obj');
      assert.ok(obj.filename.endsWith('.obj'));

      const freecad = await exporters.exportFreeCAD(mockAnalysis);
      assert.equal(requests[4].body.format, 'step');
      assert.ok(freecad.filename.endsWith('.step'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces CAD export failures instead of downloading a fabricated file', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({ error: 'CAD export needs Python with CadQuery.' }),
    });
    try {
      await assert.rejects(
        () => exporters.exportSTEP(mockAnalysis),
        /CAD export needs Python with CadQuery/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('generates native CAD parametric definitions', () => {
    const sldprt = exporters.exportSolidWorksPart(mockAnalysis);
    assert.ok(sldprt.content.includes('SOLIDWORKS PART DEFINITION') || sldprt.content.includes('SolidWorks'));
    assert.ok(sldprt.filename.endsWith('.sldprt'));

    const f3d = exporters.exportFusion360(mockAnalysis);
    assert.ok(f3d.content.includes('AUTODESK FUSION 360') || f3d.content.includes('Fusion 360'));
    assert.ok(f3d.filename.endsWith('.f3d'));
  });

  it('generates standard 3D mesh files (GLTF)', () => {
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
