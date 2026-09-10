/**
 * PipWorkbench.jsx
 * Floating, Draggable, Resizable Picture-in-Picture (PiP) 3D Workbench Window.
 * Supports Single View and Assembly View with instant switching.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { buildAssemblyScene, dimensionList, resolveLabel } from '../lib/reconstruct.js';
import { getAllComponents, ROLE_TYPES } from '../lib/machinery-context.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function getComponentEffectiveAnalysis(comp, primaryAnalysis) {
  if (!comp) return primaryAnalysis;
  if (comp.analysis) return comp.analysis;
  if (comp.role === ROLE_TYPES.PRIMARY || comp.id === 'comp-primary-gear') {
    return primaryAnalysis;
  }

  const pTeeth = primaryAnalysis?.teeth || 20;
  const pMod = primaryAnalysis?.module || 2.5;
  const pID = primaryAnalysis?.dimensions?.innerDiameter || 16;
  const pH = primaryAnalysis?.dimensions?.height || 22;

  if (comp.role === ROLE_TYPES.COMPANION || comp.id === 'comp-companion-gear') {
    const cTeeth = Math.round(pTeeth * 1.5);
    return {
      componentType: 'spur gear',
      geometryType: 'cylindrical gear',
      teeth: cTeeth,
      module: pMod,
      confidence: primaryAnalysis?.confidence || 0.88,
      dimensions: {
        outerDiameter: (cTeeth + 2) * pMod,
        innerDiameter: Math.round(pID * 1.2),
        height: pH,
      },
    };
  }

  // Additional Gear / Component
  const teeth = comp.teeth || Math.round(pTeeth * 1.2);
  return {
    componentType: comp.type || 'spur gear',
    geometryType: 'cylindrical gear',
    teeth: teeth,
    module: pMod,
    confidence: primaryAnalysis?.confidence || 0.85,
    dimensions: {
      outerDiameter: (teeth + 2) * pMod,
      innerDiameter: pID,
      height: pH,
    },
  };
}

export function PipWorkbench({
  analysis,
  machineryState,
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
  showFeatures,
  setShowFeatures,
  activeComponentId,
  setActiveComponentId,
  label,
  conf,
  onDockToMain,
  onClose,
  initialPipMode = 'single', // 'single' | 'assembly'
  ReconstructedViewport,
  cameraStateRef,
}) {
  const [pos, setPos] = useState({ x: window.innerWidth > 1200 ? window.innerWidth - 750 : 20, y: 30 });
  const [size, setSize] = useState({ width: 420, height: 300 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [pipMode, setPipMode] = useState(initialPipMode === 'assembly' ? 'assembly' : 'single');

  const hasAssemblyImages = (machineryState?.assemblyContext?.images?.length || 0) > 0;

  // Fallback if assembly mode selected without assembly images
  useEffect(() => {
    if (pipMode === 'assembly' && !hasAssemblyImages) {
      setPipMode('single');
    }
  }, [pipMode, hasAssemblyImages]);

  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, width: 0, height: 0 });
  const pipRef = useRef(null);

  const allComponents = getAllComponents(machineryState);
  const activeComp = allComponents.find((c) => c.id === activeComponentId) || machineryState?.primaryGear || allComponents[0];
  const currentAnalysis = getComponentEffectiveAnalysis(activeComp, analysis);

  // Mouse Drag Handler
  const handleMouseDownHeader = (e) => {
    if (e.target.closest('button') || e.target.closest('select')) return;
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
    e.preventDefault();
  };

  // Mouse Resize Handler
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

  const handleMouseMove = useCallback(
    (e) => {
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        const newX = Math.max(10, Math.min(window.innerWidth - size.width - 20, dragStartRef.current.posX + dx));
        const newY = Math.max(10, Math.min(window.innerHeight - size.height - 20, dragStartRef.current.posY + dy));
        setPos({ x: newX, y: newY });
      } else if (isResizing) {
        const dx = e.clientX - resizeStartRef.current.mouseX;
        const dy = e.clientY - resizeStartRef.current.mouseY;
        const newW = Math.max(300, Math.min(800, resizeStartRef.current.width + dx));
        const newH = Math.max(220, Math.min(600, resizeStartRef.current.height + dy));
        setSize({ width: newW, height: newH });
      }
    },
    [isDragging, isResizing, size.width, size.height]
  );

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
          <strong
            className="pip-title"
            title={pipMode === 'assembly' ? 'Complete Assembly 3D' : (activeComp?.name || label || 'Component')}
          >
            {pipMode === 'assembly' ? 'ASSEMBLY 3D' : `3D · ${activeComp?.name || label || 'PRIMARY GEAR'}`}
          </strong>
        </div>

        <div className="pip-header-controls">
          {/* Gear Selection Dropdown */}
          <div className="pip-gear-select-wrap">
            <select
              className="pip-gear-select"
              value={pipMode === 'assembly' ? 'assembly' : (activeComp?.id || 'comp-primary-gear')}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'assembly') {
                  if (hasAssemblyImages) {
                    setPipMode('assembly');
                  }
                } else {
                  setPipMode('single');
                  setActiveComponentId?.(val);
                }
              }}
              title="Select which gear or assembly to display in 3D"
              aria-label="Select which gear or assembly to display in 3D"
            >
              <optgroup label="Machinery View">
                <option value="assembly" disabled={!hasAssemblyImages}>
                  ⚙ Assembly {hasAssemblyImages ? '(All Gears)' : '(Requires Alignment Images)'}
                </option>
              </optgroup>
              <optgroup label="Select Gear">
                {allComponents.map((comp) => (
                  <option key={comp.id} value={comp.id}>
                    {comp.name || (comp.role === ROLE_TYPES.PRIMARY ? 'Primary Gear' : 'Gear')}
                    {comp.role === ROLE_TYPES.PRIMARY ? ' ★' : comp.role === ROLE_TYPES.COMPANION ? ' ⚙' : ''}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* Mode Switcher: Single vs Assembly */}
          <div className="pip-mode-switch">
            <button
              className={`pip-mode-btn ${pipMode === 'single' ? 'active' : ''}`}
              onClick={() => setPipMode('single')}
              title="Single Component 3D View"
            >
              Single
            </button>
            <button
              className={`pip-mode-btn ${pipMode === 'assembly' ? 'active' : ''} ${!hasAssemblyImages ? 'disabled' : ''}`}
              onClick={() => hasAssemblyImages && setPipMode('assembly')}
              disabled={!hasAssemblyImages}
              title={
                hasAssemblyImages
                  ? 'Complete Machinery Assembly 3D View'
                  : 'Assembly View requires at least 1 image uploaded under Assembly Alignment & Fit'
              }
            >
              Assembly
            </button>
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
      </div>

      {/* Interactive 3D Canvas Area */}
      <div className="pip-canvas-area">
        {ready ? (
          <div className={`model ${wire ? 'wire' : ''}`}>
            {pipMode === 'assembly' ? (
              <PipAssemblyCanvas
                machineryState={machineryState}
                wire={wire}
                grid={grid}
                stress={stress}
                autoRotate={autoRotate}
                resetKey={resetKey}
                cameraStateRef={cameraStateRef}
              />
            ) : (
              <ReconstructedViewport
                analysis={currentAnalysis}
                wire={wire}
                grid={grid}
                stress={stress}
                autoRotate={autoRotate}
                resetKey={resetKey}
                selectedFeatureId={selectedFeatureId}
                hoveredFeatureId={hoveredFeatureId}
                cameraStateRef={cameraStateRef}
              />
            )}
          </div>
        ) : (
          <div className="pip-loading">
            <Icon>view_in_ar</Icon>
            <span>Awaiting 3D Synthesis…</span>
          </div>
        )}

        {/* Dimension Overlay inside PiP */}
        {ready && dims && currentAnalysis && pipMode === 'single' && (
          <div className="pip-dims-overlay">
            <div className="pip-dim-gear-title">{activeComp?.name || 'Primary Gear'}</div>
            {dimensionList(currentAnalysis).map((d) => (
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
            onClick={() => setAutoRotate((r) => !r)}
            title="Auto-Rotate"
            aria-label="Toggle Auto-Rotate"
          >
            <Icon>360</Icon>
          </button>
          <button
            className={wire ? 'active' : ''}
            onClick={() => setWire((w) => !w)}
            title="Wireframe"
            aria-label="Toggle Wireframe"
          >
            <Icon>grid_on</Icon>
          </button>
          <button
            className={stress ? 'active' : ''}
            onClick={() => setStress((s) => !s)}
            title="FEA Stress Heatmap"
            aria-label="Toggle Stress Heatmap"
          >
            <Icon>local_fire_department</Icon>
          </button>
          <button
            className={grid ? 'active' : ''}
            onClick={() => setGrid((g) => !g)}
            title="Grid"
            aria-label="Toggle Grid"
          >
            <Icon>grid_3x3</Icon>
          </button>
          <button
            className={dims ? 'active' : ''}
            onClick={() => setDims((d) => !d)}
            title="Dimensions"
            aria-label="Toggle Dimensions"
          >
            <Icon>straighten</Icon>
          </button>
          <button
            className={showFeatures ? 'active' : ''}
            onClick={() => setShowFeatures?.((f) => !f)}
            title="Detected Features"
            aria-label="Toggle Detected Features"
          >
            <Icon>center_focus_strong</Icon>
          </button>
          <button
            onClick={() => setResetKey((k) => k + 1)}
            title="Reset Viewport"
            aria-label="Reset Viewport"
          >
            <Icon>restart_alt</Icon>
          </button>
        </div>
      </div>

      {/* Resize Grip Handle */}
      <div className="pip-resizer" onMouseDown={handleMouseDownResizer} title="Drag to resize viewport">
        <svg width="10" height="10" viewBox="0 0 10 10" className="pip-resizer-icon">
          <path d="M9 1 L1 9 M9 5 L5 9 M9 9 L9 9" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

function PipAssemblyCanvas({ machineryState, wire, grid, stress, autoRotate, resetKey, cameraStateRef }) {
  const mount = useRef(null);
  const resetRef = useRef(null);
  const options = useRef({ wire, grid, stress, autoRotate });
  options.current = { wire, grid, stress, autoRotate };

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2));
    host.appendChild(renderer.domElement);

    const { group } = buildAssemblyScene(machineryState);
    scene.add(group);
    scene.add(new THREE.AmbientLight('#7a4a38', 0.65));
    const key = new THREE.DirectionalLight('#ffb77f', 0.85);
    key.position.set(6, 8, 10);
    scene.add(key);

    const initialCam = cameraStateRef?.current || { radius: 14, theta: 0.55, phi: 1.35, target: { x: 0, y: 0, z: 0 } };
    const view = { radius: initialCam.radius, theta: initialCam.theta, phi: initialCam.phi };
    const target = new THREE.Vector3(initialCam.target?.x || 0, initialCam.target?.y || 0, initialCam.target?.z || 0);

    const syncCamera = () => {
      if (cameraStateRef) {
        cameraStateRef.current = {
          radius: view.radius,
          theta: view.theta,
          phi: view.phi,
          target: { x: target.x, y: target.y, z: target.z },
        };
      }
    };

    resetRef.current = () => {
      view.radius = 14;
      view.theta = 0.55;
      view.phi = 1.35;
      target.set(0, 0, 0);
      syncCamera();
    };

    let pointerMode = null;
    let lastPoint = null;
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';

    const onDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointerMode = e.button === 2 ? 'pan' : 'rotate';
      lastPoint = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      if (!pointerMode || !lastPoint) return;
      const dx = e.clientX - lastPoint.x;
      const dy = e.clientY - lastPoint.y;
      lastPoint = { x: e.clientX, y: e.clientY };
      if (pointerMode === 'rotate') {
        view.theta -= dx * 0.008;
        view.phi = Math.max(0.18, Math.min(Math.PI - 0.18, view.phi - dy * 0.008));
      } else {
        target.x -= dx * 0.006 * view.radius;
        target.y += dy * 0.006 * view.radius;
      }
      syncCamera();
    };
    const onUp = () => {
      pointerMode = null;
      lastPoint = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      view.radius = Math.max(3.0, Math.min(35, view.radius * (1 + e.deltaY * 0.001)));
      syncCamera();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (options.current.autoRotate) {
        view.theta += 0.005;
        syncCamera();
      }
      const r = view.radius * Math.sin(view.phi);
      camera.position.set(
        target.x + r * Math.cos(view.theta),
        target.y + view.radius * Math.cos(view.phi),
        target.z + r * Math.sin(view.theta)
      );
      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      group.traverse((n) => {
        if (n.geometry) n.geometry.dispose();
      });
      renderer.dispose();
      host.replaceChildren();
    };
  }, [machineryState]);

  useEffect(() => {
    resetRef.current?.();
  }, [resetKey]);

  return <div style={{ width: '100%', height: '100%' }} ref={mount} />;
}

export default PipWorkbench;
