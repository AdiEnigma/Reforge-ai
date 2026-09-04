/**
 * PipWorkbench.jsx
 * Floating, Draggable, Resizable Picture-in-Picture (PiP) 3D Workbench Window.
 * Keeps the fully interactive Three.js 3D viewport accessible while working inside
 * dedicated engineering work windows.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon ${className}`}>{children}</span>
);

export function PipWorkbench({
  analysis,
  ready,
  wire,
  setWire,
  grid,
  setGrid,
  stress,
  setStress,
  dims,
  setDims,
  autoRotate,
  setAutoRotate,
  resetKey,
  setResetKey,
  selectedFeatureId,
  hoveredFeatureId,
  label,
  conf,
  onDockToMain,
  onClose,
  dimensionList,
  ReconstructedViewport,
}) {
  const [pos, setPos] = useState({ x: window.innerWidth > 1200 ? window.innerWidth - 750 : 20, y: 30 });
  const [size, setSize] = useState({ width: 380, height: 280 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, width: 0, height: 0 });
  const pipRef = useRef(null);

  // Mouse Drag Handler for moving the PiP window
  const handleMouseDownHeader = (e) => {
    if (e.target.closest('button')) return; // Ignore clicks on action buttons
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
    e.preventDefault();
  };

  // Mouse Resize Handler for resizing the PiP window
  const handleMouseDownResizer = (e) => {
    setIsResizing(true);
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      width: size.width,
      height: size.height,
    };
    e.preventDefault();
    e.stopPropagation();
  };

  const handleMouseMove = useCallback((e) => {
    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      const newX = Math.max(10, Math.min(window.innerWidth - size.width - 20, dragStartRef.current.posX + dx));
      const newY = Math.max(10, Math.min(window.innerHeight - size.height - 20, dragStartRef.current.posY + dy));
      setPos({ x: newX, y: newY });
    } else if (isResizing) {
      const dx = e.clientX - resizeStartRef.current.mouseX;
      const dy = e.clientY - resizeStartRef.current.mouseY;
      const newW = Math.max(280, Math.min(800, resizeStartRef.current.width + dx));
      const newH = Math.max(200, Math.min(600, resizeStartRef.current.height + dy));
      setSize({ width: newW, height: newH });
    }
  }, [isDragging, isResizing, size.width, size.height]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, isResizing, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={pipRef}
      className={`pip-workbench ${isDragging ? 'dragging' : ''} ${isResizing ? 'resizing' : ''}`}
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
      }}
      aria-label="Picture-in-Picture 3D Workbench"
    >
      {/* Draggable Header */}
      <div className="pip-header" onMouseDown={handleMouseDownHeader}>
        <div className="pip-title-wrap">
          <span className="pip-drag-handle" title="Drag to move workbench">
            <Icon>drag_indicator</Icon>
          </span>
          <span className="pip-live-dot active"></span>
          <strong className="pip-title">3D VIEW · {label || 'COMPONENT'}</strong>
          {conf != null && <span className="pip-conf-tag">{conf}%</span>}
        </div>

        <div className="pip-actions">
          <button
            className="pip-action-btn"
            onClick={onDockToMain}
            title="Expand to Full Workbench"
            aria-label="Expand to Full Workbench"
          >
            <Icon>open_in_full</Icon>
          </button>
          <button
            className="pip-action-btn pip-close-btn"
            onClick={onClose}
            title="Close PiP Viewport"
            aria-label="Close Picture-in-Picture Viewport"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* Interactive 3D Canvas Area */}
      <div className="pip-canvas-area">
        {ready ? (
          <div className={`model ${wire ? 'wire' : ''}`}>
            <ReconstructedViewport
              analysis={analysis}
              wire={wire}
              grid={grid}
              stress={stress}
              autoRotate={autoRotate}
              resetKey={resetKey}
              selectedFeatureId={selectedFeatureId}
              hoveredFeatureId={hoveredFeatureId}
            />
          </div>
        ) : (
          <div className="pip-loading">
            <Icon>view_in_ar</Icon>
            <span>Awaiting 3D Synthesis…</span>
          </div>
        )}

        {/* Dimension Overlay inside PiP */}
        {ready && dims && (
          <div className="pip-dims-overlay">
            {dimensionList(analysis).map(d => (
              <div key={d.label} className="pip-dim-row">
                <span>{d.label}</span>
                <strong>{d.value}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Floating Mini Viewport Controls */}
        <div className="pip-controls-toolbar">
          <button
            className={autoRotate ? 'active' : ''}
            onClick={() => setAutoRotate(r => !r)}
            title="Auto-Rotate"
            aria-label="Toggle Auto-Rotate"
          >
            <Icon>360</Icon>
          </button>
          <button
            className={wire ? 'active' : ''}
            onClick={() => setWire(w => !w)}
            title="Wireframe"
            aria-label="Toggle Wireframe"
          >
            <Icon>grid_on</Icon>
          </button>
          <button
            className={stress ? 'active' : ''}
            onClick={() => setStress(s => !s)}
            title="FEA Stress Heatmap"
            aria-label="Toggle Stress Heatmap"
          >
            <Icon>local_fire_department</Icon>
          </button>
          <button
            className={grid ? 'active' : ''}
            onClick={() => setGrid(g => !g)}
            title="Grid"
            aria-label="Toggle Grid"
          >
            <Icon>grid_3x3</Icon>
          </button>
          <button
            className={dims ? 'active' : ''}
            onClick={() => setDims(d => !d)}
            title="Dimensions"
            aria-label="Toggle Dimensions"
          >
            <Icon>straighten</Icon>
          </button>
          <button
            onClick={() => setResetKey(k => k + 1)}
            title="Reset Viewport"
            aria-label="Reset Viewport"
          >
            <Icon>restart_alt</Icon>
          </button>
        </div>
      </div>

      {/* Resize Grip Handle */}
      <div
        className="pip-resizer"
        onMouseDown={handleMouseDownResizer}
        title="Drag to resize viewport"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="pip-resizer-icon">
          <path d="M9 1 L1 9 M9 5 L5 9 M9 9 L9 9" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

export default PipWorkbench;
