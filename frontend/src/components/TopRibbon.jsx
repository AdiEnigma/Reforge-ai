import React from 'react';
import {
  DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  MODEL_ILLUMINATION_MAX_INTENSITY,
  MODEL_ILLUMINATION_MIN_INTENSITY,
  MODEL_ILLUMINATION_INTENSITY_STEP,
} from '../lib/model-illumination.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function TopRibbon({
  expanded,
  onToggleExpanded,
  // Assistant & Context Toggles
  isCopilotActive = true,
  selectedContextTool = 'inspection', // 'inspection' | 'health' | 'components' | null
  onToggleCopilot,
  onToggleContextTool,
  // 3D Viewport Controls
  autoRotate,
  onToggleAutoRotate,
  wire,
  onToggleWire,
  stress,
  onToggleStress,
  grid,
  onToggleGrid,
  dims,
  onToggleDims,
  illumination = false,
  onToggleIllumination,
  illuminationIntensity = DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  onChangeIlluminationIntensity,
  modelBaseColor = null,
  onChangeModelBaseColor,
  viewportBackgroundColor = null,
  onChangeViewportBackgroundColor,
  onResetView,
  // View Modes
  viewMode,
  onChangeViewMode,
  availableGearsCount = 1,
  // Picture-in-Picture Viewport
  pipVisible = false,
  onTogglePip,
  // Workspace Layout & Focus
  isWorkspaceMaximized = false,
  onToggleMaximizeWorkspace,
  onResetLayout,
  // CAD & Simulation Tools (Moved from workspace)
  onOpenWhatIf,
  isWhatIfActive = false,
  onOpen2DDrawing,
  onOpenExport,
  isExportActive = false,
  // Manufacturing Mode
  isManufacturingActive,
  onToggleManufacture,
  // Report
  onOpenReport,
  isManufacturingComplete,
  onShowReportNotice,
  // Theme Management
  theme = 'dark',
  onToggleTheme,
  // Navigation
  onNavigateHome,
  onNavigateUpload,
  // General
  ready = false,
  canManufacture = ready,
  label = '',
}) {
  const lightTheme = theme === 'light';
  const illuminationOnLabel = lightTheme
    ? 'Turn Off Model Shade Control'
    : 'Turn Off 3D Model Illumination';
  const illuminationOffLabel = lightTheme
    ? 'Turn On Model Shade Control (deeper metallic orange)'
    : 'Turn On 3D Model Illumination (overhead light)';
  const intensityLabel = lightTheme
    ? 'Model shade depth'
    : 'Overhead model light intensity';
  return (
    <header className={`top-ribbon ${expanded ? 'expanded' : 'collapsed'}`} role="toolbar" aria-label="Engineering Workspace Ribbon">
      {/* Category 0: Brand & Ribbon Mode */}
      <div className="ribbon-cat-panel brand-panel">
        <div className="ribbon-brand-group">
          <button
            className="ribbon-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded?.();
            }}
            title={expanded ? "Collapse Ribbon to Icons Only" : "Expand Ribbon with Labels"}
            aria-label={expanded ? "Collapse Ribbon" : "Expand Ribbon"}
          >
            <Icon>{expanded ? 'unfold_less' : 'unfold_more'}</Icon>
          </button>
          <div
            className="ribbon-title-col"
            onClick={onNavigateHome}
            title={onNavigateHome ? "Go to Home" : undefined}
            style={{ cursor: onNavigateHome ? 'pointer' : 'default' }}
          >
            <span className="ribbon-brand-name">RE:FORGE</span>
            {expanded && <span className="ribbon-brand-sub">WORKSPACE</span>}
          </div>
          {onNavigateHome && (
            <button
              className="ribbon-item mini home-btn"
              onClick={onNavigateHome}
              title="Return to Home / Landing Page"
              aria-label="Home"
            >
              <Icon>home</Icon>
              {expanded && <span className="ribbon-label">Home</span>}
            </button>
          )}
        </div>
      </div>

      <div className="ribbon-divider" />

      {/* Category 1: ASSISTANT & CONTEXT (2-Row Cluster) */}
      <div className="ribbon-cat-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ${isCopilotActive ? 'active' : ''}`}
            onClick={onToggleCopilot}
            title="Toggle Engineering Copilot in Left Panel"
            aria-label="Engineering Copilot Chat"
          >
            <Icon>smart_toy</Icon>
            {expanded && <span className="ribbon-label">Copilot</span>}
          </button>

          <button
            className={`ribbon-item mini ${selectedContextTool === 'inspection' ? 'active' : ''}`}
            onClick={() => onToggleContextTool('inspection')}
            disabled={!ready}
            title={selectedContextTool === 'inspection' ? "Click to close Inspected Details" : "Open Inspected Details"}
            aria-label="Inspected Details and Detected Features"
          >
            <Icon>center_focus_strong</Icon>
            {expanded && <span className="ribbon-label">Inspection</span>}
          </button>

          <button
            className={`ribbon-item mini ${selectedContextTool === 'health' ? 'active' : ''}`}
            onClick={() => onToggleContextTool('health')}
            disabled={!ready}
            title={selectedContextTool === 'health' ? "Click to close Health Panel" : "Open Health & Damage Analysis"}
            aria-label="Component Health and Defect Analysis"
          >
            <Icon>health_and_safety</Icon>
            {expanded && <span className="ribbon-label">Health</span>}
          </button>

          <button
            className={`ribbon-item mini ${selectedContextTool === 'components' ? 'active' : ''}`}
            onClick={() => onToggleContextTool('components')}
            title={selectedContextTool === 'components' ? "Click to close Components Panel" : "Manage Components & Assemblies"}
            aria-label="Manage Components"
          >
            <Icon>category</Icon>
            {expanded && <span className="ribbon-label">Components</span>}
          </button>
        </div>
        {expanded && <span className="ribbon-cat-title">CONTEXT</span>}
      </div>

      <div className="ribbon-divider" />

      {/* Category 2: 3D TOOLS (Compact 2-Row Cluster) */}
      <div className="ribbon-cat-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ${autoRotate ? 'active' : ''}`}
            onClick={onToggleAutoRotate}
            disabled={!ready}
            title="Toggle Auto-Rotation (360°)"
            aria-label="Toggle Auto-Rotation"
          >
            <Icon>360</Icon>
            {expanded && <span className="ribbon-label">Rotate</span>}
          </button>

          <button
            className={`ribbon-item mini ${wire ? 'active' : ''}`}
            onClick={onToggleWire}
            disabled={!ready}
            title="Toggle Wireframe Visualization"
            aria-label="Toggle Wireframe"
          >
            <Icon>grid_on</Icon>
            {expanded && <span className="ribbon-label">Wire</span>}
          </button>

          <button
            className={`ribbon-item mini ${stress ? 'active' : ''}`}
            onClick={onToggleStress}
            disabled={!ready}
            title="Toggle Image-Based Damage Heatmap (detected defect regions)"
            aria-label="Toggle Damage Heatmap"
          >
            <Icon>local_fire_department</Icon>
            {expanded && <span className="ribbon-label">Heatmap</span>}
          </button>

          <button
            className={`ribbon-item mini ${grid ? 'active' : ''}`}
            onClick={onToggleGrid}
            disabled={!ready}
            title="Toggle Coordinate Grid"
            aria-label="Toggle Grid"
          >
            <Icon>grid_3x3</Icon>
            {expanded && <span className="ribbon-label">Grid</span>}
          </button>

          <button
            className={`ribbon-item mini ${dims ? 'active' : ''}`}
            onClick={onToggleDims}
            disabled={!ready}
            title="Toggle Dimension Annotations"
            aria-label="Toggle Dimensions"
          >
            <Icon>straighten</Icon>
            {expanded && <span className="ribbon-label">Dims</span>}
          </button>

          <button
            className={`ribbon-item mini illumination-toggle-btn icon-only ${illumination ? 'active' : ''}`}
            onClick={onToggleIllumination}
            disabled={!ready || !onToggleIllumination}
            title={illumination ? illuminationOnLabel : illuminationOffLabel}
            aria-label={illumination ? illuminationOnLabel : illuminationOffLabel}
            aria-pressed={illumination}
          >
            <Icon>lightbulb</Icon>
          </button>

          {illumination && (
            <input
              className="illumination-intensity"
              type="range"
              min={MODEL_ILLUMINATION_MIN_INTENSITY}
              max={MODEL_ILLUMINATION_MAX_INTENSITY}
              step={MODEL_ILLUMINATION_INTENSITY_STEP}
              value={illuminationIntensity}
              onChange={(event) => onChangeIlluminationIntensity?.(Number(event.target.value))}
              disabled={!ready || !onChangeIlluminationIntensity}
              title={`${intensityLabel}: ${Math.round(illuminationIntensity * 100)}%`}
              aria-label={intensityLabel}
            />
          )}

          <label className="ribbon-item mini ribbon-color-picker" title="Object base color (auto-generates metallic shades)">
            <input
              type="color"
              value={modelBaseColor || '#b76308'}
              onChange={(event) => onChangeModelBaseColor?.(event.target.value)}
              disabled={!ready || !onChangeModelBaseColor}
              aria-label="Object base color"
              style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: ready ? 'pointer' : 'default' }}
            />
            {expanded && <span className="ribbon-label">Object</span>}
          </label>
          {modelBaseColor && (
            <button
              className="ribbon-item mini"
              onClick={() => onChangeModelBaseColor?.(null)}
              disabled={!ready}
              title="Reset object color"
              aria-label="Reset object color"
            >
              <Icon>format_color_reset</Icon>
            </button>
          )}

          <label className="ribbon-item mini ribbon-color-picker" title="Viewport background color">
            <input
              type="color"
              value={viewportBackgroundColor || (theme === 'light' ? '#dfe3e8' : '#140d07')}
              onChange={(event) => onChangeViewportBackgroundColor?.(event.target.value)}
              disabled={!ready || !onChangeViewportBackgroundColor}
              aria-label="Viewport background color"
              style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: ready ? 'pointer' : 'default' }}
            />
            {expanded && <span className="ribbon-label">BG</span>}
          </label>
          {viewportBackgroundColor && (
            <button
              className="ribbon-item mini"
              onClick={() => onChangeViewportBackgroundColor?.(null)}
              disabled={!ready}
              title="Reset background color"
              aria-label="Reset background color"
            >
              <Icon>format_color_reset</Icon>
            </button>
          )}

          <button
            className="ribbon-item mini"
            onClick={onResetView}
            disabled={!ready}
            title="Reset Camera & Orientation"
            aria-label="Reset View"
          >
            <Icon>restart_alt</Icon>
            {expanded && <span className="ribbon-label">Reset</span>}
          </button>
        </div>
        {expanded && <span className="ribbon-cat-title">3D TOOLS</span>}
      </div>

      <div className="ribbon-divider" />

      {/* Category 3: VIEW (2-Row Cluster) */}
      <div className="ribbon-cat-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ${viewMode === 'single' ? 'active' : ''}`}
            onClick={() => onChangeViewMode('single')}
            disabled={!ready}
            title="Single Component View"
            aria-label="Single View"
          >
            <Icon>crop_square</Icon>
            {expanded && <span className="ribbon-label">Single</span>}
          </button>

          <button
            className={`ribbon-item mini ${viewMode === 'dual' ? 'active' : ''}`}
            onClick={() => onChangeViewMode('dual')}
            disabled={!ready || availableGearsCount < 2}
            title={availableGearsCount < 2 ? "Requires 2+ components" : "Dual Split View"}
            aria-label="Dual View"
          >
            <Icon>splitscreen</Icon>
            {expanded && <span className="ribbon-label">Double</span>}
          </button>

          <button
            className={`ribbon-item mini ${viewMode === 'quad' ? 'active' : ''}`}
            onClick={() => onChangeViewMode('quad')}
            disabled={!ready || availableGearsCount < 3}
            title={availableGearsCount < 3 ? "Requires 3+ components" : "Quad Grid View"}
            aria-label="Quad View"
          >
            <Icon>grid_view</Icon>
            {expanded && <span className="ribbon-label">Quad</span>}
          </button>

          <button
            className={`ribbon-item mini ${viewMode === 'assembly' ? 'active' : ''}`}
            onClick={() => onChangeViewMode('assembly')}
            disabled={!ready || availableGearsCount < 2}
            title={availableGearsCount < 2 ? "Requires multi-component kinematics" : "Kinematic Assembly View"}
            aria-label="Assembly View"
          >
            <Icon>hub</Icon>
            {expanded && <span className="ribbon-label">Assembly</span>}
          </button>

          {onTogglePip && (
            <button
              className={`ribbon-item mini ${pipVisible ? 'active' : ''}`}
              onClick={onTogglePip}
              disabled={!ready}
              title={pipVisible ? "Dock 3D Viewport back to Workspace" : "Picture-in-Picture 3D Viewport"}
              aria-label="Toggle Picture-in-Picture Mode"
            >
              <Icon>picture_in_picture_alt</Icon>
              {expanded && <span className="ribbon-label">PiP</span>}
            </button>
          )}

          {onToggleMaximizeWorkspace && (
            <button
              className={`ribbon-item mini ${isWorkspaceMaximized ? 'active' : ''}`}
              onClick={onToggleMaximizeWorkspace}
              title={isWorkspaceMaximized ? "Restore Workspace Panels" : "Focus Mode (Maximize 3D Workspace)"}
              aria-label="Focus 3D Viewport"
            >
              <Icon>{isWorkspaceMaximized ? 'fullscreen_exit' : 'fit_screen'}</Icon>
              {expanded && <span className="ribbon-label">{isWorkspaceMaximized ? 'Restore' : 'Focus'}</span>}
            </button>
          )}
        </div>
        {expanded && <span className="ribbon-cat-title">VIEW</span>}
      </div>

      <div className="ribbon-divider" />

      {/* Category 4: CAD & SIMULATE (Moved from workspace) */}
      <div className="ribbon-cat-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ${isWhatIfActive ? 'active' : ''}`}
            onClick={onOpenWhatIf}
            disabled={!ready}
            title="Engineering What-If Parameter Simulator & Sensitivity"
            aria-label="What-If Simulator"
          >
            <Icon>tune</Icon>
            {expanded && <span className="ribbon-label">What-If</span>}
          </button>

          <button
            className="ribbon-item mini"
            onClick={onOpen2DDrawing}
            disabled={!ready}
            title="Open 2D Engineering Technical Drawing (GD&T / Title Block)"
            aria-label="2D Technical Drawing"
          >
            <Icon>architecture</Icon>
            {expanded && <span className="ribbon-label">2D Drawing</span>}
          </button>
        </div>
        {expanded && <span className="ribbon-cat-title">SIMULATE &amp; 2D</span>}
      </div>

      <div className="ribbon-divider" />

      {/* Category 5: MANUFACTURING & SPECIFICATION */}
      <div className="ribbon-cat-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ribbon-cta-manufacture ${isManufacturingActive ? 'active' : ''}`}
            onClick={onToggleManufacture}
            disabled={!canManufacture}
            title="Activate Manufacturing Decisions & Cost Estimation Workspace"
            aria-label="Manufacture Workspace"
          >
            <Icon>precision_manufacturing</Icon>
            {expanded && <span className="ribbon-label">Manufacture</span>}
          </button>

          <button
            className="ribbon-item mini ribbon-cta-report"
            onClick={() => {
              if (isManufacturingComplete) {
                onOpenReport();
              } else {
                onShowReportNotice();
              }
            }}
            disabled={!ready}
            title="Review and Generate Engineering Report Specification"
            aria-label="Engineering Report"
          >
            <Icon>description</Icon>
            {expanded && <span className="ribbon-label">Report</span>}
          </button>
        </div>
        {expanded && <span className="ribbon-cat-title">MANUFACTURING</span>}
      </div>

      <div className="ribbon-divider" />

      {/* Category 6: PROJECT & EXPORT (Moved from workspace) */}
      <div className="ribbon-cat-panel project-panel">
        <div className="ribbon-cat-grid-2row">
          <button
            className={`ribbon-item mini ${isExportActive ? 'active' : ''}`}
            onClick={onOpenExport}
            disabled={!ready}
            title="Export CAD & Simulation Files (STEP, STL, DXF, INP)"
            aria-label="Export CAD Files"
          >
            <Icon>download</Icon>
            {expanded && <span className="ribbon-label">Export</span>}
          </button>

          {onNavigateUpload && (
            <button
              className="ribbon-item mini"
              onClick={onNavigateUpload}
              title="Upload Component or Add New Views"
              aria-label="Upload Component"
            >
              <Icon>upload</Icon>
              {expanded && <span className="ribbon-label">Upload</span>}
            </button>
          )}

          {onResetLayout && (
            <button
              className="ribbon-item mini"
              onClick={onResetLayout}
              title="Restore Default Layout & Reset Panel Positions"
              aria-label="Reset Workspace Layout"
            >
              <Icon>restart_alt</Icon>
              {expanded && <span className="ribbon-label">Reset Layout</span>}
            </button>
          )}

          {onToggleTheme && (
            <button
              className={`ribbon-item mini theme-toggle-btn icon-only ${theme === 'light' ? 'light-active' : ''}`}
              onClick={onToggleTheme}
              title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`}
              aria-label={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`}
            >
              <Icon>{theme === 'light' ? 'dark_mode' : 'light_mode'}</Icon>
            </button>
          )}

          {ready ? (
            <div className="ribbon-status-pill mini" title={`Active Model: ${label}`}>
              <span className="ribbon-status-dot" />
              <span className="ribbon-status-text">{label || 'ONLINE'}</span>
            </div>
          ) : (
            <div className="ribbon-status-pill mini offline" title="Awaiting component synthesis">
              <span className="ribbon-status-dot offline" />
              <span className="ribbon-status-text">OFFLINE</span>
            </div>
          )}
        </div>
        {expanded && <span className="ribbon-cat-title">EXPORT &amp; PROJECT</span>}
      </div>
    </header>
  );
}

export default TopRibbon;
