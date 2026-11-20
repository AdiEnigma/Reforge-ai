/**
 * MultiViewportGrid.jsx
 * Multi-component 3D Viewport supporting Single View, Dual View, Quad View, and Assembly View.
 *
 * Rules:
 * 1. Dynamic View Modes based on gear count:
 *    - 1 Gear: Single View Only (Dual/Quad/Assembly disabled with descriptive tooltips)
 *    - 2 Gears: Single View and Dual View enabled (Quad/Assembly disabled)
 *    - 3 Gears: Single View, Dual View, and Quad View enabled (Viewport 4 displays empty state slot)
 *    - 4+ Gears: Single View, Dual View, Quad View, and Assembly View all enabled
 * 2. View Configuration UI:
 *    - Dynamic viewport assignment dropdowns for Dual View (Viewport 1 & 2) and Quad View (Viewport 1, 2, 3, 4)
 *    - Dropdowns list only reconstructed/available gears with clear status indicators
 * 3. Empty-state slot for Viewport 4 when only 3 gears exist with quick-action upload trigger
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { buildModel, buildAssemblyScene, dimensionList, resolveLabel } from '../lib/reconstruct.js';
import { createModelIllumination, DEFAULT_MODEL_ILLUMINATION_INTENSITY } from '../lib/model-illumination.js';
import { createThreeThemeSync } from '../lib/three-theme.js';
import { getAllComponents, ROLE_TYPES } from '../lib/machinery-context.js';
import { DamageHeatmapOverlay } from './DamageHeatmapOverlay.jsx';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

/**
 * Individual 3D Viewport Card/Panel
 */
function SingleViewportCanvas({
  analysis,
  images = [],
  title = 'COMPONENT',
  isAssembly = false,
  machineryState = null,
  wire,
  grid,
  stress,
  autoRotate,
  illumination = false,
  illuminationIntensity = DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  theme = 'dark',
  resetKey,
  selectedFeatureId,
  hoveredFeatureId,
  onSelectComponent,
  headerControls = null,
}) {
  const mount = useRef(null);
  const resetViewRef = useRef(null);
  const options = useRef({ wire, grid, autoRotate, illumination, illuminationIntensity, theme, selectedFeatureId, hoveredFeatureId });
  options.current = { wire, grid, autoRotate, illumination, illuminationIntensity, theme, selectedFeatureId, hoveredFeatureId };

  if (!analysis && !isAssembly) {
    return (
      <div className="single-viewport-pane">
        <div className="viewport-pane-header">
          <span className="pane-title">{title}</span>
          {headerControls}
        </div>
        <div className="viewport-empty-slot" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }}>
          <Icon className="spin">sync</Icon>
          <span style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '0.05em', color: '#ffb77f' }}>AWAITING COMPONENT ANALYSIS…</span>
          <span style={{ fontSize: '11px', color: '#a08875' }}>Upload or select photos in the left panel to reconstruct 3D CAD geometry.</span>
        </div>
      </div>
    );
  }

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2));
    host.appendChild(renderer.domElement);
    const themeSync = createThreeThemeSync({ scene, renderer });
    themeSync.update(options.current.theme);

    let mainGroup;
    if (isAssembly && machineryState) {
      const { group } = buildAssemblyScene(machineryState);
      mainGroup = group;
    } else {
      const { group } = buildModel(analysis);
      mainGroup = group;
    }
    scene.add(mainGroup);
    const modelBounds = new THREE.Box3().setFromObject(mainGroup);

    scene.add(new THREE.AmbientLight('#7a4a38', 0.65));
    const key = new THREE.DirectionalLight('#ffb77f', 0.85);
    key.position.set(6, 8, 10);
    scene.add(key);
    const fill = new THREE.PointLight('#b76308', 1.1, 30);
    fill.position.set(-6, -4, 8);
    scene.add(fill);
    const illuminationLight = createModelIllumination(scene, {
      enabled: options.current.illumination,
      intensity: options.current.illuminationIntensity,
      bounds: modelBounds,
      camera,
    });

    const gridHelper = new THREE.GridHelper(12, 14, '#544337', '#3d332c');
    gridHelper.position.z = -1.2;
    gridHelper.visible = false;
    scene.add(gridHelper);

    const originals = new Map();
    mainGroup.traverse((node) => {
      if (node.isMesh) originals.set(node.uuid, node.material);
    });

    const wireMaterial = new THREE.MeshBasicMaterial({ color: '#b5e67e', wireframe: true });
    const selectHighlightMat = new THREE.MeshStandardMaterial({
      color: '#c9f88d',
      emissive: '#c9f88d',
      emissiveIntensity: 0.8,
      metalness: 0.5,
      roughness: 0.25,
    });
    const hoverHighlightMat = new THREE.MeshStandardMaterial({
      color: '#ffb77f',
      emissive: '#ffb77f',
      emissiveIntensity: 0.5,
      metalness: 0.5,
      roughness: 0.35,
    });
    const compBox = new THREE.Box3().setFromObject(mainGroup);
    const compSize = compBox.getSize(new THREE.Vector3());
    const compMaxDim = Math.max(compSize.x, compSize.y, compSize.z, 1);
    const defaultRadius = isAssembly ? Math.max(14, compMaxDim * 1.8) : Math.max(8.5, compMaxDim * 1.5);
    const defaultTheta = 0.75;
    const defaultPhi = 1.15;

    const view = { radius: defaultRadius, theta: defaultTheta, phi: defaultPhi };
    const target = new THREE.Vector3();
    const reset = () => {
      view.radius = defaultRadius;
      view.theta = defaultTheta;
      view.phi = defaultPhi;
      target.set(0, 0, 0);
    };
    resetViewRef.current = reset;

    let pointerMode = null;
    let lastPoint = null;
    let appliedKey = null;

    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';

    const onDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointerMode = e.button === 2 ? 'pan' : 'rotate';
      lastPoint = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      onSelectComponent?.();
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
    };

    const onUp = () => {
      pointerMode = null;
      lastPoint = null;
      canvas.style.cursor = 'grab';
    };

    const onWheel = (e) => {
      e.preventDefault();
      view.radius = Math.max(2.5, Math.min(35, view.radius * (1 + e.deltaY * 0.001)));
    };

    const preventContext = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', preventContext);

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
      if (options.current.autoRotate) view.theta += 0.005;
      gridHelper.visible = options.current.grid;
      themeSync.update(options.current.theme);
      illuminationLight.update({
        enabled: options.current.illumination,
        intensity: options.current.illuminationIntensity,
      });

      const activeFeatureId = options.current.selectedFeatureId || options.current.hoveredFeatureId || null;
      const isSel = Boolean(options.current.selectedFeatureId);
      const materialKey = `${options.current.wire ? 'w' : ''}|${activeFeatureId ?? ''}`;

      if (materialKey !== appliedKey) {
        appliedKey = materialKey;
        mainGroup.traverse((node) => {
          if (!node.isMesh) return;
          if (node.userData?.isHighlightOnly) {
            node.visible = Boolean(activeFeatureId && node.userData.featureId === activeFeatureId);
          } else if (options.current.wire) {
            node.material = wireMaterial;
          } else if (
            activeFeatureId &&
            (node.userData?.featureId === activeFeatureId || node.parent?.userData?.featureId === activeFeatureId)
          ) {
            node.material = isSel ? selectHighlightMat : hoverHighlightMat;
          } else {
            node.material = originals.get(node.uuid) || node.material;
          }
        });
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
      canvas.removeEventListener('contextmenu', preventContext);
      mainGroup.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
      });
      wireMaterial.dispose();
      selectHighlightMat.dispose();
      hoverHighlightMat.dispose();
      illuminationLight.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [analysis, isAssembly, machineryState]);

  useEffect(() => {
    resetViewRef.current?.();
  }, [resetKey]);

  return (
    <div className="single-viewport-pane">
      <div className="viewport-pane-header">
        <span className="pane-title">{title}</span>
        {isAssembly && <span className="pane-assembly-tag">INTEGRATED 3D SCENE</span>}
        {headerControls}
      </div>
      <div className="single-viewport-mount" ref={mount} />
      {stress && (
        <DamageHeatmapOverlay analysis={analysis} images={images} />
      )}
    </div>
  );
}

/**
 * Empty Viewport Slot Placeholder (e.g. Viewport 4 in 3-gear setup)
 */
function EmptyViewportSlot({ slotIndex = 4, totalGears = 3, onOpenImageManager }) {
  return (
    <div className="single-viewport-pane empty-viewport-pane">
      <div className="viewport-pane-header">
        <span className="pane-title">VIEWPORT {slotIndex} · UNASSIGNED</span>
      </div>
      <div className="empty-viewport-content">
        <div className="empty-slot-icon-box">
          <Icon>add_photo_alternate</Icon>
        </div>
        <h4>Empty Viewport Slot</h4>
        <p>
          Quad View is active with <strong>{totalGears} gears</strong>. Add an additional gear (Gear {totalGears + 1}) through image upload to populate this viewport.
        </p>
        <button
          className="comp-btn-secondary"
          onClick={onOpenImageManager}
          title="Open Image Manager to add another gear"
        >
          <Icon>add</Icon> Upload Images for Gear {totalGears + 1}
        </button>
      </div>
    </div>
  );
}

export function MultiViewportGrid({
  viewMode = 'single', // 'single' | 'dual' | 'quad' | 'assembly'
  setViewMode,
  machineryState,
  activeComponentId,
  setActiveComponentId,
  selectedComponentIds,
  setSelectedComponentIds,
  wire,
  grid,
  stress,
  autoRotate,
  illumination = false,
  illuminationIntensity = DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  theme = 'dark',
  resetKey,
  selectedFeatureId,
  hoveredFeatureId,
  ready,
  onOpenImageManager,
}) {
  const allComponents = useMemo(() => getAllComponents(machineryState), [machineryState]);
  const primary = machineryState?.primaryGear;
  const companion = machineryState?.companionGear;
  const additional = machineryState?.additionalComponents || [];

  // Calculate total gears in machinery
  const totalGears = useMemo(() => {
    let count = 0;
    if (primary) count++;
    if (companion) count++;
    additional.forEach((c) => {
      if (c.role === ROLE_TYPES.ADDITIONAL_GEAR || c.type?.toLowerCase().includes('gear') || c.name?.toLowerCase().includes('gear')) {
        count++;
      }
    });
    return count;
  }, [primary, companion, additional]);

  // Viewport assignment state for Dual and Quad views
  const [dualAssignments, setDualAssignments] = useState([
    primary?.id || allComponents[0]?.id || 'comp-primary',
    companion?.id || additional[0]?.id || allComponents[1]?.id || 'comp-companion',
  ]);

  const [quadAssignments, setQuadAssignments] = useState([
    primary?.id || allComponents[0]?.id || 'comp-primary',
    companion?.id || additional[0]?.id || allComponents[1]?.id || 'comp-companion',
    additional[0]?.id || allComponents[2]?.id || 'comp-add-1',
    additional[1]?.id || allComponents[3]?.id || 'none',
  ]);

  // Sync initial assignments when components change
  useEffect(() => {
    if (allComponents.length > 0) {
      setDualAssignments((prev) => [
        allComponents.find((c) => c.id === prev[0]) ? prev[0] : (primary?.id || allComponents[0]?.id),
        allComponents.find((c) => c.id === prev[1]) ? prev[1] : (companion?.id || additional[0]?.id || allComponents[1]?.id || allComponents[0]?.id),
      ]);
      setQuadAssignments((prev) => [
        allComponents.find((c) => c.id === prev[0]) ? prev[0] : (primary?.id || allComponents[0]?.id),
        allComponents.find((c) => c.id === prev[1]) ? prev[1] : (companion?.id || additional[0]?.id || allComponents[1]?.id || allComponents[0]?.id),
        allComponents.find((c) => c.id === prev[2]) ? prev[2] : (additional[0]?.id || allComponents[2]?.id || 'none'),
        allComponents.find((c) => c.id === prev[3]) ? prev[3] : (additional[1]?.id || allComponents[3]?.id || 'none'),
      ]);
    }
  }, [allComponents.length, primary?.id, companion?.id]);

  // Safety fallback if viewMode is invalid for current gear count
  useEffect(() => {
    if (totalGears < 2 && viewMode !== 'single') {
      setViewMode?.('single');
    } else if (totalGears === 2 && (viewMode === 'quad' || viewMode === 'assembly')) {
      setViewMode?.('dual');
    } else if (totalGears === 3 && viewMode === 'assembly') {
      setViewMode?.('quad');
    }
  }, [totalGears, viewMode, setViewMode]);

  // Active single component & analysis
  const activeComponent =
    allComponents.find((c) => c.id === activeComponentId) || primary || allComponents[0];
  const activeAnalysis = activeComponent?.analysis || null;

  const handleSelectComponent = (id) => {
    setActiveComponentId?.(id);
  };

  // Helper to get component & analysis by assigned ID
  const getAssignedComp = (assignedId, fallbackIdx = 0) => {
    if (!assignedId || assignedId === 'none') return null;
    const found = allComponents.find((c) => c.id === assignedId);
    if (found) return found;
    return allComponents[fallbackIdx] || null;
  };

  // View Mode availability checks
  const isDualEnabled = totalGears >= 2;
  const isQuadEnabled = totalGears >= 3;
  const isAssemblyEnabled = totalGears >= 4;

  const dualTooltip = isDualEnabled
    ? 'Dual Split View (2 Viewports)'
    : 'Requires at least 2 gears to enable Dual View';

  const quadTooltip = isQuadEnabled
    ? 'Quad 4-Pane View (3-4 Viewports)'
    : 'Requires at least 3 gears to enable Quad View';

  const assemblyTooltip = isAssemblyEnabled
    ? 'Complete Machinery Assembly View (4+ Gears)'
    : 'Requires at least 4 gears to enable Assembly View';

  // Render Viewport Dropdown Selector
  const renderViewportDropdown = (currentId, onSelect, label = '') => (
    <select
      className="viewport-config-select"
      value={currentId || 'none'}
      onChange={(e) => onSelect(e.target.value)}
      title={`Select component for ${label}`}
    >
      {allComponents.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} {c.analysis?.teeth ? `(${c.analysis.teeth}T)` : ''}
        </option>
      ))}
      <option value="none">-- Empty Slot --</option>
    </select>
  );

  return (
    <div className="multi-viewport-root">
      {/* Top View Mode & Selection Switcher Toolbar */}
      <div className="viewport-top-toolbar" aria-label="3D Viewport Controls">
        <div className="view-mode-buttons">
          {/* Single View Button */}
          <button
            className={`view-mode-btn ${viewMode === 'single' ? 'active' : ''}`}
            onClick={() => setViewMode('single')}
            title="Single Component View"
          >
            <Icon>crop_square</Icon> Single View
          </button>

          {/* Dual View Button */}
          <button
            className={`view-mode-btn ${viewMode === 'dual' ? 'active' : ''} ${!isDualEnabled ? 'disabled' : ''}`}
            onClick={() => isDualEnabled && setViewMode('dual')}
            disabled={!isDualEnabled}
            title={dualTooltip}
          >
            <Icon>view_column</Icon> Dual View
            {!isDualEnabled && <span className="view-lock-badge">2+ Gears</span>}
          </button>

          {/* Quad View Button */}
          <button
            className={`view-mode-btn ${viewMode === 'quad' ? 'active' : ''} ${!isQuadEnabled ? 'disabled' : ''}`}
            onClick={() => isQuadEnabled && setViewMode('quad')}
            disabled={!isQuadEnabled}
            title={quadTooltip}
          >
            <Icon>grid_view</Icon> Quad View
            {!isQuadEnabled && <span className="view-lock-badge">3+ Gears</span>}
          </button>

          {/* Assembly View Button */}
          <button
            className={`view-mode-btn ${viewMode === 'assembly' ? 'active' : ''} ${!isAssemblyEnabled ? 'disabled' : ''}`}
            onClick={() => isAssemblyEnabled && setViewMode('assembly')}
            disabled={!isAssemblyEnabled}
            title={assemblyTooltip}
          >
            <Icon>view_in_ar</Icon> Assembly View
            {!isAssemblyEnabled && <span className="view-lock-badge">4+ Gears</span>}
          </button>
        </div>

        {/* Component Selector / Viewport Configuration Header */}
        <div className="viewport-comp-selector">
          {viewMode === 'single' && (
            <div className="comp-radio-group">
              <span className="selector-label">VIEWING:</span>
              {allComponents.map((comp) => (
                <button
                  key={comp.id}
                  className={`comp-pill-btn ${activeComponentId === comp.id ? 'active' : ''}`}
                  onClick={() => handleSelectComponent(comp.id)}
                >
                  <span className={`pill-role-dot ${comp.role?.toLowerCase().replace(/\s+/g, '-')}`} />
                  {comp.name}
                </button>
              ))}
            </div>
          )}

          {viewMode === 'dual' && (
            <div className="viewport-config-summary">
              <span className="selector-label">VIEW CONFIG:</span>
              <span className="config-pill">
                VP 1: <strong>{getAssignedComp(dualAssignments[0], 0)?.name || 'Primary'}</strong>
              </span>
              <span className="config-divider">|</span>
              <span className="config-pill">
                VP 2: <strong>{getAssignedComp(dualAssignments[1], 1)?.name || 'Companion'}</strong>
              </span>
            </div>
          )}

          {viewMode === 'quad' && (
            <div className="viewport-config-summary">
              <span className="selector-label">4-PANE CONFIG:</span>
              <span className="config-pill">1: {getAssignedComp(quadAssignments[0], 0)?.name || 'Gear 1'}</span>
              <span className="config-pill">2: {getAssignedComp(quadAssignments[1], 1)?.name || 'Gear 2'}</span>
              <span className="config-pill">3: {getAssignedComp(quadAssignments[2], 2)?.name || 'Gear 3'}</span>
              <span className="config-pill">
                4: {getAssignedComp(quadAssignments[3])?.name || (totalGears === 3 ? 'Empty (3 Gears)' : 'Gear 4')}
              </span>
            </div>
          )}

          {viewMode === 'assembly' && (
            <div className="comp-radio-group">
              <span className="selector-label">ASSEMBLY ELEMENTS:</span>
              <span className="assembly-summary-pill">
                Primary + {companion ? companion.name : 'Gear 2'} + {additional.length} components ({totalGears} Total Gears)
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Main 3D Canvas Rendering Area based on viewMode */}
      <div className={`viewport-panes-container mode-${viewMode}`}>
        {/* SINGLE VIEW */}
        {viewMode === 'single' && (
          <SingleViewportCanvas
            analysis={activeAnalysis}
            images={activeComponent?.images}
            title={activeComponent?.name || resolveLabel(activeAnalysis)}
            wire={wire}
            grid={grid}
            stress={stress}
            autoRotate={autoRotate}
            illumination={illumination}
            illuminationIntensity={illuminationIntensity}
            theme={theme}
            resetKey={resetKey}
            selectedFeatureId={selectedFeatureId}
            hoveredFeatureId={hoveredFeatureId}
          />
        )}

        {/* DUAL VIEW */}
        {viewMode === 'dual' && (
          <div className="dual-view-grid">
            {/* Viewport 1 */}
            {(() => {
              const comp1 = getAssignedComp(dualAssignments[0], 0) || primary || allComponents[0];
              const analysis1 = comp1?.analysis || activeAnalysis;
              return (
                <SingleViewportCanvas
                  analysis={analysis1}
                  images={comp1?.images}
                  title={`VP 1 · ${comp1?.name || 'Primary Gear'}`}
                  headerControls={renderViewportDropdown(
                    dualAssignments[0],
                    (newId) => setDualAssignments([newId, dualAssignments[1]]),
                    'Viewport 1'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(comp1?.id)}
                />
              );
            })()}

            {/* Viewport 2 */}
            {(() => {
              const comp2 = getAssignedComp(dualAssignments[1], 1) || companion || additional[0] || allComponents[1] || allComponents[0];
              const analysis2 = comp2?.analysis || null;
              return (
                <SingleViewportCanvas
                  analysis={analysis2}
                  images={comp2?.images}
                  title={`VP 2 · ${comp2?.name || 'Companion Gear'}`}
                  headerControls={renderViewportDropdown(
                    dualAssignments[1],
                    (newId) => setDualAssignments([dualAssignments[0], newId]),
                    'Viewport 2'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(comp2?.id)}
                />
              );
            })()}
          </div>
        )}

        {/* QUAD VIEW */}
        {viewMode === 'quad' && (
          <div className="quad-view-grid">
            {/* Slot 1 */}
            {(() => {
              const comp1 = getAssignedComp(quadAssignments[0], 0) || primary || allComponents[0];
              return (
                <SingleViewportCanvas
                  analysis={comp1?.analysis || activeAnalysis}
                  images={comp1?.images}
                  title={`1. ${comp1?.name || 'Primary Gear'}`}
                  headerControls={renderViewportDropdown(
                    quadAssignments[0],
                    (newId) => setQuadAssignments([newId, quadAssignments[1], quadAssignments[2], quadAssignments[3]]),
                    'Viewport 1'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(comp1?.id)}
                />
              );
            })()}

            {/* Slot 2 */}
            {(() => {
              const comp2 = getAssignedComp(quadAssignments[1], 1) || companion || additional[0] || allComponents[1];
              return (
                <SingleViewportCanvas
                  analysis={comp2?.analysis || null}
                  images={comp2?.images}
                  title={`2. ${comp2?.name || 'Companion Gear'}`}
                  headerControls={renderViewportDropdown(
                    quadAssignments[1],
                    (newId) => setQuadAssignments([quadAssignments[0], newId, quadAssignments[2], quadAssignments[3]]),
                    'Viewport 2'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(comp2?.id)}
                />
              );
            })()}

            {/* Slot 3 */}
            {(() => {
              const comp3 = getAssignedComp(quadAssignments[2], 2) || additional[0] || allComponents[2];
              return (
                <SingleViewportCanvas
                  analysis={comp3?.analysis || null}
                  images={comp3?.images}
                  title={`3. ${comp3?.name || 'Gear 3'}`}
                  headerControls={renderViewportDropdown(
                    quadAssignments[2],
                    (newId) => setQuadAssignments([quadAssignments[0], quadAssignments[1], newId, quadAssignments[3]]),
                    'Viewport 3'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(comp3?.id)}
                />
              );
            })()}

            {/* Slot 4: 4th Gear OR Empty State Slot when only 3 gears exist */}
            {(() => {
              const comp4 = getAssignedComp(quadAssignments[3]);
              if (!comp4 && totalGears === 3) {
                return (
                  <EmptyViewportSlot
                    slotIndex={4}
                    totalGears={totalGears}
                    onOpenImageManager={onOpenImageManager}
                  />
                );
              }

              const fallbackComp4 = comp4 || additional[1] || allComponents[3];
              if (!fallbackComp4) {
                return (
                  <EmptyViewportSlot
                    slotIndex={4}
                    totalGears={totalGears}
                    onOpenImageManager={onOpenImageManager}
                  />
                );
              }

              return (
                <SingleViewportCanvas
                  analysis={fallbackComp4?.analysis || null}
                  images={fallbackComp4?.images}
                  title={`4. ${fallbackComp4?.name || 'Gear 4'}`}
                  headerControls={renderViewportDropdown(
                    quadAssignments[3],
                    (newId) => setQuadAssignments([quadAssignments[0], quadAssignments[1], quadAssignments[2], newId]),
                    'Viewport 4'
                  )}
                  wire={wire}
                  grid={grid}
                  stress={stress}
                  autoRotate={autoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  onSelectComponent={() => handleSelectComponent(fallbackComp4?.id)}
                />
              );
            })()}
          </div>
        )}

        {/* ASSEMBLY VIEW */}
        {viewMode === 'assembly' && (
          <SingleViewportCanvas
            isAssembly={true}
            machineryState={machineryState}
            analysis={primary?.analysis}
            images={primary?.images}
            title="COMPLETE MACHINERY ASSEMBLY"
            wire={wire}
            grid={grid}
            stress={stress}
            autoRotate={autoRotate}
            illumination={illumination}
            illuminationIntensity={illuminationIntensity}
            theme={theme}
            resetKey={resetKey}
            selectedFeatureId={selectedFeatureId}
            hoveredFeatureId={hoveredFeatureId}
          />
        )}
      </div>
    </div>
  );
}

export default MultiViewportGrid;
