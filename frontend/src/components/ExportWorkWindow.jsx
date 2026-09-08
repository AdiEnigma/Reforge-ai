/**
 * ExportWorkWindow.jsx
 * Comprehensive Engineering Export Center with 10 industry categories
 * and individual format download buttons.
 */

import React, { useState } from 'react';
import * as exporters from '../lib/exporters.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

const EXPORT_CATEGORIES = [
  {
    id: 'cad',
    title: 'CAD',
    icon: 'category',
    badge: 'Neutral B-Rep Solids',
    description: 'Universal parametric solid and surface boundary representations for interoperability across MCAD systems.',
    formats: [
      { name: 'STEP', ext: '.step', label: 'ISO 10303-21 Standard', action: exporters.exportSTEP },
      { name: 'IGES', ext: '.iges', label: 'Initial Graphics Exchange Spec', action: exporters.exportIGES },
      { name: 'Parasolid Text', ext: '.x_t', label: 'Siemens Parasolid Text Schema', action: exporters.exportParasolidText },
      { name: 'Parasolid Binary', ext: '.x_b', label: 'Siemens Parasolid Binary Transmit', action: exporters.exportParasolidBinary },
      { name: 'ACIS', ext: '.sat', label: 'Spatial ACIS 3D SAT Format', action: exporters.exportACIS },
      { name: 'JT', ext: '.jt', label: 'ISO 14306 JT Open CAD', action: exporters.exportJT },
    ],
  },
  {
    id: 'native-cad',
    title: 'Native CAD',
    icon: 'construction',
    badge: 'Feature Tree & Parameters',
    description: 'Direct model translation packages configured with sketches, dimensions, and feature trees for leading CAD packages.',
    formats: [
      { name: 'Fusion 360', ext: '.f3d', label: 'Autodesk Fusion 360 Archive', action: exporters.exportFusion360 },
      { name: 'Inventor Part', ext: '.ipt', label: 'Autodesk Inventor Part Document', action: exporters.exportInventorPart },
      { name: 'Inventor Assembly', ext: '.iam', label: 'Autodesk Inventor Assembly Model', action: exporters.exportInventorAssembly },
      { name: 'SOLIDWORKS Part', ext: '.sldprt', label: 'Dassault Systèmes Part Model', action: exporters.exportSolidWorksPart },
      { name: 'SOLIDWORKS Assembly', ext: '.sldasm', label: 'Dassault Systèmes Assembly Model', action: exporters.exportSolidWorksAssembly },
      { name: 'CATIA Part', ext: '.CATPart', label: 'Dassault CATIA V5/V6 Part', action: exporters.exportCatiaPart },
      { name: 'CATIA Assembly', ext: '.CATProduct', label: 'Dassault CATIA Assembly Product', action: exporters.exportCatiaAssembly },
      { name: 'Siemens NX', ext: '.prt', label: 'Siemens NX Unigraphics Part', action: exporters.exportSiemensNX },
      { name: 'Creo Assembly', ext: '.asm', label: 'PTC Creo Parametric Model', action: exporters.exportCreoAssembly },
      { name: 'Rhino', ext: '.3dm', label: 'Rhino 3D OpenNURBS Geometry', action: exporters.exportRhino },
      { name: 'FreeCAD', ext: '.FCStd', label: 'FreeCAD Native XML Document', action: exporters.exportFreeCAD },
    ],
  },
  {
    id: '3d-mesh',
    title: '3D',
    icon: 'view_in_ar',
    badge: 'Tessellated & Additive',
    description: 'Surface meshes and faceted models optimized for 3D printing, rendering, simulation, and spatial visualization.',
    formats: [
      { name: 'STL', ext: '.stl', label: 'Stereolithography 3D Mesh', action: exporters.exportSTL },
      { name: 'OBJ', ext: '.obj', label: 'Wavefront 3D Object with Normals', action: exporters.exportOBJ },
      { name: '3MF', ext: '.3mf', label: '3D Manufacturing Format', action: exporters.export3MF },
      { name: 'GLB', ext: '.glb', label: 'Binary glTF 2.0 Web Container', action: exporters.exportGLB },
      { name: 'GLTF', ext: '.gltf', label: 'glTF 2.0 JSON Scene Document', action: exporters.exportGLTF },
      { name: 'FBX', ext: '.fbx', label: 'Autodesk Filmbox 3D Asset', action: exporters.exportFBX },
      { name: 'PLY', ext: '.ply', label: 'Polygon File Format Mesh', action: exporters.exportPLY },
      { name: 'USDZ', ext: '.usdz', label: 'Universal Scene Description AR', action: exporters.exportUSDZ },
    ],
  },
  {
    id: 'drawing',
    title: 'Engineering Drawing',
    icon: 'architecture',
    badge: '2D Orthographic Vector',
    description: 'Standard multi-view technical drafting sheets with third-angle projection, dimension annotations, and ISO title blocks.',
    formats: [
      { name: 'DXF', ext: '.dxf', label: 'AutoCAD Drawing Exchange Format', action: exporters.exportDXF },
      { name: 'DWG', ext: '.dwg', label: 'AutoCAD Binary Drawing Package', action: exporters.exportDWG },
      { name: 'SVG', ext: '.svg', label: 'Scalable Vector Graphic Projection', action: (a, m) => exporters.exportDrawingSVG(a, m) },
      { name: 'PDF', ext: '.pdf', label: 'ISO 5457 A4 Technical Drawing Sheet', action: (a, m) => exporters.exportDrawingPDF(a, m) },
    ],
  },
  {
    id: 'manufacturing',
    title: 'Manufacturing',
    icon: 'precision_manufacturing',
    badge: 'CNC Toolpaths & G-Code',
    description: 'Pre-configured CNC lathe, mill, and turn-mill machining scripts with canned cycles, speeds, and feedrates.',
    formats: [
      { name: 'NC', ext: '.nc', label: 'Standard Fanuc / ISO NC Program', action: exporters.exportNC },
      { name: 'GCODE', ext: '.gcode', label: 'Metric Absolute CNC G-Code', action: exporters.exportGCODE },
      { name: 'APT', ext: '.apt', label: 'Automatically Programmed Tool Script', action: exporters.exportAPT },
      { name: 'TAP', ext: '.tap', label: 'CAM Output Mill / Turn Program', action: exporters.exportTAP },
    ],
  },
  {
    id: 'scanning',
    title: '3D Scanning',
    icon: 'cloud_upload',
    badge: 'Point Clouds & LiDAR',
    description: 'Spatial coordinate arrays and point cloud datasets for reverse engineering and metrology inspection.',
    formats: [
      { name: 'PLY', ext: '.ply', label: 'Stanford Point Cloud Format', action: exporters.exportPLY },
      { name: 'LAS', ext: '.las', label: 'ASPRS LiDAR Point Cloud', action: exporters.exportLAS },
      { name: 'LAZ', ext: '.laz', label: 'Compressed LiDAR Data File', action: exporters.exportLAZ },
      { name: 'E57', ext: '.e57', label: 'ASTM E57 3D Imaging Format', action: exporters.exportE57 },
      { name: 'PTS', ext: '.pts', label: 'Leica Cyclone Laser Scan Format', action: exporters.exportPTS },
      { name: 'PTX', ext: '.ptx', label: 'Registered Gridded Point Cloud', action: exporters.exportPTX },
      { name: 'PCD', ext: '.pcd', label: 'Point Cloud Library (PCL) Format', action: exporters.exportPCD },
    ],
  },
  {
    id: 'simulation',
    title: 'Simulation',
    icon: 'science',
    badge: 'FEA Mesh & Boundary Cards',
    description: 'Finite element analysis input decks with materials, solid element topologies, and boundary condition cards.',
    formats: [
      { name: 'INP', ext: '.inp', label: 'Abaqus FEA Input Deck', action: exporters.exportINP },
      { name: 'ODB', ext: '.odb', label: 'Abaqus Database Container', action: exporters.exportODB },
      { name: 'BDF', ext: '.bdf', label: 'MSC / NX Nastran Bulk Data File', action: exporters.exportBDF },
      { name: 'DAT', ext: '.dat', label: 'ANSYS APDL Command Script', action: exporters.exportDAT },
      { name: 'MESH', ext: '.mesh', label: 'INRIA Medit FEA Surface Mesh', action: exporters.exportMESH },
      { name: 'MSH', ext: '.msh', label: 'Gmsh Finite Element Mesh', action: exporters.exportMSH },
      { name: 'VTK', ext: '.vtk', label: 'Visualization Toolkit ASCII File', action: exporters.exportVTK },
      { name: 'VTU', ext: '.vtu', label: 'VTK Unstructured Grid XML', action: exporters.exportVTU },
    ],
  },
  {
    id: 'material',
    title: 'Material Data',
    icon: 'layers',
    badge: 'Mechanical & Thermal Specs',
    description: 'Comprehensive material properties, yield limits, densities, machinability indices, and thermal coefficients.',
    formats: [
      { name: 'MATLAB Material Data', ext: '.mat', label: 'MATLAB Binary Matrix Container', action: exporters.exportMaterialMAT },
      { name: 'Material Database', ext: '.xml', label: 'ISO Material XML Schema Record', action: exporters.exportMaterialXML },
      { name: 'Material Metadata', ext: '.json', label: 'Structured JSON Material Properties', action: exporters.exportMaterialJSON },
      { name: 'Material Properties', ext: '.csv', label: 'Tabular ASTM Specification Sheet', action: exporters.exportMaterialCSV },
      { name: 'Material Configuration', ext: '.yaml', label: 'Human-Readable YAML Specs', action: exporters.exportMaterialYAML },
    ],
  },
  {
    id: 'laser',
    title: 'Laser Cutting / Sheet Metal',
    icon: 'offline_bolt',
    badge: '2D Contours & Kerf Paths',
    description: 'Clean outer and inner profile paths optimized for CNC laser, plasma, waterjet, and sheet metal fabrication.',
    formats: [
      { name: 'DXF', ext: '.dxf', label: '2D Cutting Profile DXF', action: exporters.exportLaserDXF },
      { name: 'DWG', ext: '.dwg', label: 'CAD Drawing Laser Layout', action: exporters.exportLaserDWG },
      { name: 'SVG', ext: '.svg', label: 'Vector Cutpath Contour SVG', action: exporters.exportLaserSVG },
      { name: 'AI', ext: '.ai', label: 'Adobe Illustrator Vector File', action: exporters.exportLaserAI },
      { name: 'EPS', ext: '.eps', label: 'Encapsulated PostScript Cutpath', action: exporters.exportLaserEPS },
      { name: 'NC', ext: '.nc', label: '2D CNC Laser Cutting G-Code', action: exporters.exportLaserNC },
    ],
  },
  {
    id: 'bim',
    title: 'BIM / Architecture / Construction',
    icon: 'domain',
    badge: 'IFC & BIM Objects',
    description: 'Building Information Modeling objects with spatial placement, building element classifications, and Revit interoperability.',
    formats: [
      { name: 'IFC', ext: '.ifc', label: 'IFC4 BuildingSMART Mechanical Solid', action: exporters.exportIFC },
      { name: 'Revit Project', ext: '.rvt', label: 'Autodesk Revit Project Package', action: exporters.exportRevitRVT },
      { name: 'Revit Family', ext: '.rfa', label: 'Autodesk Revit Family Component', action: exporters.exportRevitRFA },
      { name: 'Revit Template', ext: '.rte', label: 'Autodesk Revit Template File', action: exporters.exportRevitRTE },
      { name: 'DWG', ext: '.dwg', label: 'BIM Engineering Model DWG', action: exporters.exportBIMDWG },
      { name: 'DXF', ext: '.dxf', label: 'BIM Geometry Exchange DXF', action: exporters.exportBIMDXF },
      { name: 'DGN', ext: '.dgn', label: 'Bentley MicroStation Design File', action: exporters.exportDGN },
    ],
  },
];

export function ExportWorkWindow({ analysis, mfgData }) {
  const [activeCategory, setActiveCategory] = useState('all');
  const [downloadedFormat, setDownloadedFormat] = useState(null);

  const handleDownload = (format) => {
    try {
      format.action(analysis, mfgData);
      setDownloadedFormat(`${format.name} (${format.ext})`);
      setTimeout(() => setDownloadedFormat(null), 3000);
    } catch (err) {
      console.error(`Export failed for ${format.name}:`, err);
    }
  };

  const filteredCategories = activeCategory === 'all'
    ? EXPORT_CATEGORIES
    : EXPORT_CATEGORIES.filter(c => c.id === activeCategory);

  const totalFormats = EXPORT_CATEGORIES.reduce((acc, c) => acc + c.formats.length, 0);

  return (
    <div className="work-window export-window">
      <header className="work-window-header">
        <div className="work-window-title-col">
          <div className="work-window-tag"><Icon>download</Icon> EXPORT CENTER</div>
          <h2>Multi-Format CAD, CAM, BIM & Simulation Exporter</h2>
          <p>
            Synthesize and download production-grade exchange formats directly from AI geometric reconstruction.
            Every format is generated with verifiable dimensions, material attributes, and coordinate systems.
          </p>
        </div>
        <div className="export-stats-col">
          <div className="export-stat-box">
            <span className="export-stat-num">{totalFormats}</span>
            <span className="export-stat-label">SUPPORTED FORMATS</span>
          </div>
          <div className="export-stat-box">
            <span className="export-stat-num">10</span>
            <span className="export-stat-label">CATEGORIES</span>
          </div>
        </div>
      </header>

      {downloadedFormat && (
        <div className="export-toast-banner" role="status">
          <Icon>check_circle</Icon>
          <span>Successfully exported <strong>{downloadedFormat}</strong> for {analysis?.label || 'Component'}</span>
        </div>
      )}

      <div className="export-category-filter">
        <button
          className={`export-filter-btn ${activeCategory === 'all' ? 'active' : ''}`}
          onClick={() => setActiveCategory('all')}
        >
          ALL CATEGORIES ({totalFormats})
        </button>
        {EXPORT_CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className={`export-filter-btn ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            <Icon>{cat.icon}</Icon> {cat.title} ({cat.formats.length})
          </button>
        ))}
      </div>

      <div className="export-categories-grid">
        {filteredCategories.map(cat => (
          <section key={cat.id} className="export-category-card">
            <div className="export-category-head">
              <div className="export-category-title-wrap">
                <Icon className="export-category-icon">{cat.icon}</Icon>
                <div>
                  <h3>{cat.title}</h3>
                  <span className="export-category-desc">{cat.description}</span>
                </div>
              </div>
              <span className="export-category-badge">{cat.badge}</span>
            </div>

            <div className="export-formats-grid">
              {cat.formats.map((fmt, idx) => (
                <button
                  key={idx}
                  className="export-format-btn"
                  onClick={() => handleDownload(fmt)}
                  title={`Download ${fmt.name} (${fmt.ext})`}
                >
                  <div className="export-format-info">
                    <span className="export-format-name">{fmt.name}</span>
                    <span className="export-format-label">{fmt.label}</span>
                  </div>
                  <div className="export-format-ext-chip">
                    <span>{fmt.ext}</span>
                    <Icon>download</Icon>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default ExportWorkWindow;
