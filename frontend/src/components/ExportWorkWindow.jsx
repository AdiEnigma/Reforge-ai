import React, { useState } from 'react';
import { exportGLTF, exportOBJ } from '../lib/exporters.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function fileSlug(analysis) {
  return String(analysis?.componentName || analysis?.componentType || 'component')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
}

export function ExportWorkWindow({ analysis, cadBuild }) {
  const [message, setMessage] = useState('');
  const result = cadBuild?.result?.result;
  const mesh = cadBuild?.mesh;
  const ready = cadBuild?.status === 'ready';
  const blocked = !ready || Boolean(result?.exportBlocked);
  const slug = fileSlug(analysis);

  const handleMeshExport = async (label, action) => {
    try {
      await action();
      setMessage(`${label} exported from the generated CAD solid.`);
    } catch (error) {
      console.error(`${label} export failed:`, error);
      setMessage(`${label} export failed: ${error?.message || 'Could not export the generated mesh.'}`);
    }
  };

  return (
    <div className="work-window export-window">
      <header className="work-window-header">
        <div className="work-window-title-col">
          <div className="work-window-tag"><Icon>download</Icon> CAD EXPORTS</div>
          <h2>Export the generated CAD solid</h2>
          <p>STEP and STL come from the Python CAD engine. OBJ and GLB are exported from the same returned mesh at its original millimetre scale.</p>
        </div>
        <div className="export-stats-col">
          <div className="export-stat-box">
            <span className="export-stat-num">{ready ? (blocked ? 1 : 4) : 0}</span>
            <span className="export-stat-label">AVAILABLE FORMATS</span>
          </div>
        </div>
      </header>

      {!ready && (
        <p className="cad-export-status cad-export-blocked" role="status">
          {cadBuild?.status === 'building'
            ? 'CAD generation is in progress.'
            : cadBuild?.error || 'Generate the parametric CAD solid before exporting.'}
        </p>
      )}
      {ready && blocked && (
        <p className="cad-export-status cad-export-blocked" role="status">
          {result?.exportBlockedReason || 'Enter one user-provided or measured dimension to enable scale-dependent exports.'}
        </p>
      )}
      {ready && result?.hasEstimates && (
        <p className="dims-estimate-notice">This model includes estimated dimensions. Review the provenance labels before using the files.</p>
      )}
      {message && <p className="export-toast-banner" role="status">{message}</p>}

      <section className="export-category-card">
        <div className="export-category-head">
          <div className="export-category-title-wrap">
            <Icon className="export-category-icon">category</Icon>
            <div>
              <h3>Generated solid</h3>
              <span className="export-category-desc">Files are available only when produced by the CAD service or the actual CAD preview mesh.</span>
            </div>
          </div>
        </div>
        <div className="export-formats-grid">
          {ready && result?.stepUrl && (
            <a className="export-format-btn" href={result.stepUrl} download>
              <span className="export-format-info"><strong className="export-format-name">STEP</strong><span className="export-format-label">CadQuery / OpenCASCADE solid</span></span>
              <span className="export-format-ext-chip">.step <Icon>download</Icon></span>
            </a>
          )}
          {ready && result?.stlUrl && (
            <a className="export-format-btn" href={result.stlUrl} download>
              <span className="export-format-info"><strong className="export-format-name">STL</strong><span className="export-format-label">CadQuery tessellation</span></span>
              <span className="export-format-ext-chip">.stl <Icon>download</Icon></span>
            </a>
          )}
          <button className="export-format-btn" disabled={blocked || !mesh} onClick={() => handleMeshExport('OBJ', () => exportOBJ(mesh, `${slug}.obj`))}>
            <span className="export-format-info"><strong className="export-format-name">OBJ</strong><span className="export-format-label">Actual generated CAD mesh</span></span>
            <span className="export-format-ext-chip">.obj <Icon>download</Icon></span>
          </button>
          <button className="export-format-btn" disabled={blocked || !mesh} onClick={() => handleMeshExport('GLB', () => exportGLTF(mesh, `${slug}.glb`, true))}>
            <span className="export-format-info"><strong className="export-format-name">GLB</strong><span className="export-format-label">Binary glTF from actual CAD mesh</span></span>
            <span className="export-format-ext-chip">.glb <Icon>download</Icon></span>
          </button>
        </div>
      </section>
    </div>
  );
}

export default ExportWorkWindow;
