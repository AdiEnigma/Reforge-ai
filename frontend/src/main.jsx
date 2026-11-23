import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import './styles.css';
import { analyzeComponent, analyzeCondition, sendChatMessage, isCancellationError } from './lib/api.js';
import { fetchManufacturingIntelligence } from './lib/manufacturing.js';
import { fetchMaterialAlternatives } from './lib/material-comparison.js';
import { normalizeFeatures } from './lib/features.js';
import { GEAR_TYPES, applyConfirmedGearType, isGearTypeUnconfirmed } from './lib/gear-types.js';
import { buildEngineeringContext, getEngineeringSuggestions } from './lib/engineering-context.js';
import { buildDrawingModel, renderDrawingToSvg, exportSvg, exportPng, exportPdf } from './lib/drawing/index.js';
import { buildModel, buildAssemblyScene, dimensionList, resolveLabel, validateReconstructedModel } from './lib/reconstruct.js';
import { createModelIllumination, DEFAULT_MODEL_ILLUMINATION_INTENSITY } from './lib/model-illumination.js';
import { createThreeThemeSync, getWireframeAppearance } from './lib/three-theme.js';
import {
  PARAM_DEFINITIONS,
  isParamActive,
  getParameterValue,
  getParameterRecommendations,
  applyScenarioToAnalysis,
  getGeometryDecisionOverrides,
} from './lib/what-if.js';
import {
  applyReconstructionEvent,
  createReconstructionProgress,
  getReconstructionStageLabel,
  RECONSTRUCTION_CANCELLED,
  RECONSTRUCTION_COMPLETE,
  RECONSTRUCTION_FAILED,
  RECONSTRUCTION_IDLE,
  RECONSTRUCTION_RUNNING,
} from './lib/reconstruction-progress.js';
import {
  createInitialMachineryState,
  getAllComponents,
  hasDirtyContext,
  createMachinerySnapshot,
  addImagesToComponent,
  removeImageFromComponent,
  assignComponentRole,
  addAdditionalComponent,
  removeComponent,
  ROLE_TYPES,
} from './lib/machinery-context.js';
import { ManageComponentsTab } from './components/ManageComponentsTab.jsx';
import { MultiViewportGrid } from './components/MultiViewportGrid.jsx';
import { PipWorkbench } from './components/PipWorkbench.jsx';
import { DamageHeatmapOverlay } from './components/DamageHeatmapOverlay.jsx';
import { ExportWorkWindow } from './components/ExportWorkWindow.jsx';
import { TopRibbon } from './components/TopRibbon.jsx';
import { FloatingPanelWrapper } from './components/FloatingPanelWrapper.jsx';
import { DockDropOverlay } from './components/DockDropOverlay.jsx';
import {
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  resetWorkspaceLayout,
  repositionPanelSlot,
  enforceResponsiveBounds,
  DEFAULT_WORKSPACE_LAYOUT,
  LAYOUT_BOUNDS,
} from './lib/workspace-layout.js';
import { LeftContextualPanel } from './components/LeftContextualPanel.jsx';
import { ManufacturingDecisionPanel } from './components/ManufacturingDecisionPanel.jsx';
import { CostEstimationPanel } from './components/CostEstimationPanel.jsx';
import { ReportEditorDialog } from './components/ReportEditorDialog.jsx';
import {
  evaluateTechnicalDependencies,
  computeConfiguratorStatuses,
  loadManufacturingState,
  saveManufacturingState,
} from './lib/manufacturing-config.js';

const AppContext = createContext();
const useApp = () => useContext(AppContext);
const Icon = ({ children, className = '' }) => <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>;

const STEPS = ['UPLOAD', 'ANALYZING COMPONENT', 'EXTRACTING GEOMETRY', 'RECONSTRUCTING MODEL', 'MODEL READY'];

function ProgressStepper({ index }) {
  return (
    <ol className="state-track" aria-label="Reconstruction progress" aria-live="polite">
      {STEPS.map((step, i) => (
        <li key={step} className={`state-step ${i < index ? 'done' : ''} ${i === index ? 'active' : ''}`}>
          <span className="state-dot" />
          {step}
        </li>
      ))}
    </ol>
  );
}

function ReconstructionProgress({ progress, onCancel, onRetry }) {
  if (
    !progress ||
    progress.status === RECONSTRUCTION_IDLE ||
    progress.status === RECONSTRUCTION_COMPLETE
  ) return null;

  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const stageLabel = progress.status === RECONSTRUCTION_COMPLETE
    ? 'Model Ready'
    : getReconstructionStageLabel(progress.currentStage);
  const detail = progress.message || (
    progress.status === RECONSTRUCTION_FAILED
      ? 'Reconstruction failed.'
      : progress.status === RECONSTRUCTION_CANCELLED
        ? 'Reconstruction cancelled.'
        : `${stageLabel}…`
  );

  return (
    <section className="reconstruction-progress" aria-label="Live reconstruction progress" aria-live="polite">
      <div className="reconstruction-progress__head">
        <span className="cad">RECONSTRUCTION PROGRESS</span>
        <div className="reconstruction-progress__readout">
          <strong className="reconstruction-progress__stage">{stageLabel}</strong>
          <span className="reconstruction-progress__percent">{percent}%</span>
        </div>
      </div>
      <div
        className={`reconstruction-progress__track reconstruction-progress--${progress.status}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% — ${stageLabel}`}
      >
        <div className="reconstruction-progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="reconstruction-progress__foot">
        <span className="reconstruction-progress__detail">{detail}</span>
        <div className="reconstruction-progress__actions">
          {progress.status === RECONSTRUCTION_RUNNING && onCancel && (
            <button type="button" className="reconstruction-progress__action" onClick={onCancel}>
              <Icon>close</Icon> CANCEL
            </button>
          )}
          {(progress.status === RECONSTRUCTION_FAILED || progress.status === RECONSTRUCTION_CANCELLED) && onRetry && (
            <button type="button" className="reconstruction-progress__action primary" onClick={onRetry}>
              <Icon>refresh</Icon> RETRY
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function GearCanvas({ theme = 'dark' }) {
  const mount = useRef(null);
  const options = useRef({ theme });
  options.current = { theme };
  useEffect(() => {
    const host = mount.current, scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 1000); camera.position.z = 15;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); host.appendChild(renderer.domElement);
    const shape = new THREE.Shape(); const teeth = 8, radius = 3.2, tooth = .8;
    shape.moveTo(radius, 0); for (let i = 0; i < teeth; i++) { const a = i * Math.PI * 2 / teeth, s = Math.PI * 2 / teeth / 4; shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius); shape.lineTo(Math.cos(a + s) * (radius + tooth), Math.sin(a + s) * (radius + tooth)); shape.lineTo(Math.cos(a + s * 2) * (radius + tooth), Math.sin(a + s * 2) * (radius + tooth)); shape.lineTo(Math.cos(a + s * 3) * radius, Math.sin(a + s * 3) * radius); } shape.lineTo(radius, 0);
    const hole = new THREE.Path(); hole.absarc(0, 0, 2.2, 0, Math.PI * 2, false); shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: .25, bevelEnabled: true, bevelSegments: 12, steps: 2, curveSegments: 64, bevelSize: .05, bevelThickness: .05 }); geo.center();
    const material = new THREE.MeshStandardMaterial({ color: '#2A0E06', metalness: .8, roughness: .45, emissive: '#0a0301', emissiveIntensity: .2 });
    material.userData.appearanceRole = 'decorative-gear';
    const edgesMaterial = new THREE.LineBasicMaterial({ color: '#DE822B' });
    edgesMaterial.userData.appearanceRole = 'edges';
    const gear = new THREE.Mesh(geo, material); const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 22), edgesMaterial); gear.add(edges); scene.add(gear);
    [1, -1].forEach(z => {
      const ringMaterial = new THREE.MeshBasicMaterial({ color: '#DE822B', side: THREE.DoubleSide });
      ringMaterial.userData.appearanceRole = 'rim';
      const ring = new THREE.Mesh(new THREE.RingGeometry(2.15, 2.28, 64), ringMaterial);
      ring.position.z = z * .14;
      gear.add(ring);
    });
    const ambient = new THREE.AmbientLight('#7A4A38', .9); scene.add(ambient);
    const light = new THREE.PointLight('#DE822B', 2.5, 30); light.position.set(8, 8, 8); scene.add(light);
    const tenne = new THREE.PointLight('#B76308', 2.2, 30); tenne.position.set(-8, -8, 6); scene.add(tenne);
    // Keep the hero transparent: only the model lighting rig follows the theme.
    const themeSync = createThreeThemeSync({
      scene,
      renderer,
      lights: { ambient, key: light, fill: tenne },
      background: false,
    });
    themeSync.update(options.current.theme, true);
    const pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 }, current = { x: 0, y: 0 }; const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
    const onMove = e => { const r = host.getBoundingClientRect(); pointer.x = (e.clientX - r.left) / r.width * 2 - 1; pointer.y = -(e.clientY - r.top) / r.height * 2 + 1; target.x = (e.clientX - r.left - r.width / 2) * .0018; target.y = (e.clientY - r.top - r.height / 2) * .0018; }; host.addEventListener('pointermove', onMove);
    const resize = () => { const { width, height } = host.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false) }; const observer = new ResizeObserver(resize); observer.observe(host); resize(); let frame;
    const animate = () => { frame = requestAnimationFrame(animate); mouse.set(pointer.x, pointer.y); raycaster.setFromCamera(mouse, camera); const active = raycaster.intersectObject(gear).length > 0; material.emissive.lerp(new THREE.Color(active ? '#DE822B' : '#0a0301'), active ? .04 : .03); current.x = THREE.MathUtils.lerp(current.x, target.x, .035); current.y = THREE.MathUtils.lerp(current.y, target.y, .035); gear.rotation.x = current.y; gear.rotation.y = current.x; gear.rotation.z -= .006 * (active ? 1.8 : 1); themeSync.update(options.current.theme); renderer.render(scene, camera) }; animate();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); host.removeEventListener('pointermove', onMove); themeSync.dispose(); renderer.dispose(); geo.dispose(); material.dispose(); host.replaceChildren(); };
  }, []);
  return <div className="gear-canvas" ref={mount} aria-hidden="true" />;
}

function ReconstructedViewport({ analysis, images = [], wire, grid, stress, autoRotate, illumination = false, illuminationIntensity = DEFAULT_MODEL_ILLUMINATION_INTENSITY, theme = 'dark', resetKey, selectedFeatureId, hoveredFeatureId, modelBaseColor = null, viewportBackgroundColor = null }) {
  const mount = useRef(null);
  const resetViewRef = useRef(null);
  const themeSyncRef = useRef(null);
  const options = useRef({ wire, grid, autoRotate, illumination, illuminationIntensity, theme, selectedFeatureId, hoveredFeatureId, modelBaseColor, viewportBackgroundColor });
  options.current = { wire, grid, autoRotate, illumination, illuminationIntensity, theme, selectedFeatureId, hoveredFeatureId, modelBaseColor, viewportBackgroundColor };

  useEffect(() => {
    const host = mount.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const ambient = new THREE.AmbientLight('#7a4a38', 0.6); scene.add(ambient);
    const key = new THREE.DirectionalLight('#ffb77f', 0.8); key.position.set(6, 8, 10); scene.add(key);
    const fill = new THREE.PointLight('#b76308', 1.0, 25); fill.position.set(-5, -4, 6); scene.add(fill);
    const themeSync = createThreeThemeSync({
      scene,
      renderer,
      lights: { ambient, key, fill },
      baseColor: options.current.modelBaseColor,
      backgroundColor: options.current.viewportBackgroundColor,
    });
    themeSyncRef.current = themeSync;
    themeSync.update(options.current.theme);
    const { group } = buildModel(analysis);
    scene.add(group);
    themeSync.update(options.current.theme, true);
    const modelBounds = new THREE.Box3().setFromObject(group);
    const illuminationLight = createModelIllumination(scene, {
      enabled: options.current.illumination,
      intensity: options.current.illuminationIntensity,
      theme: options.current.theme,
      themeSync,
      bounds: modelBounds,
      camera,
    });
    const gridHelper = new THREE.GridHelper(10, 12, '#544337', '#3d332c'); gridHelper.position.z = -1.2; gridHelper.visible = false; scene.add(gridHelper);

    const originals = new Map();
    group.traverse(node => { if (node.isMesh) originals.set(node.uuid, node.material); });

    const wireAppearance = getWireframeAppearance(options.current.theme);
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: wireAppearance.color,
      wireframe: true,
      transparent: true,
      opacity: wireAppearance.opacity,
      blending: wireAppearance.blending,
      depthWrite: wireAppearance.depthWrite,
    });
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

    const stressMaterial = createStressMaterial();
    const view = { radius: 11, theta: 0.55, phi: 1.35 }; const target = new THREE.Vector3();
    const reset = () => { view.radius = 11; view.theta = 0.55; view.phi = 1.35; target.set(0, 0, 0); }; resetViewRef.current = reset;
    let pointerMode = null, lastPoint = null, appliedKey = null;
    const canvas = renderer.domElement; canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab';
    const onDown = event => { canvas.setPointerCapture(event.pointerId); pointerMode = event.button === 2 ? 'pan' : 'rotate'; lastPoint = { x: event.clientX, y: event.clientY }; canvas.style.cursor = 'grabbing'; };
    const onMove = event => { if (!pointerMode || !lastPoint) return; const dx = event.clientX - lastPoint.x, dy = event.clientY - lastPoint.y; lastPoint = { x: event.clientX, y: event.clientY }; if (pointerMode === 'rotate') { view.theta -= dx * .008; view.phi = Math.max(.18, Math.min(Math.PI - .18, view.phi - dy * .008)); } else { target.x -= dx * .006 * view.radius; target.y += dy * .006 * view.radius; } };
    const onUp = () => { pointerMode = null; lastPoint = null; canvas.style.cursor = 'grab'; };
    const onWheel = event => { event.preventDefault(); view.radius = Math.max(2.5, Math.min(20, view.radius * (1 + event.deltaY * .001))); };
    const preventContext = event => event.preventDefault();
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', preventContext);
    const resize = () => { const { width, height } = host.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); }; const observer = new ResizeObserver(resize); observer.observe(host); resize();

    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (options.current.autoRotate) view.theta += .006;
      gridHelper.visible = options.current.grid;
      themeSync.update(options.current.theme);
      illuminationLight.update({
        enabled: options.current.illumination,
        intensity: options.current.illuminationIntensity,
        theme: options.current.theme,
      });

      const activeFeatureId = options.current.selectedFeatureId || options.current.hoveredFeatureId || null;
      const isSelected = Boolean(options.current.selectedFeatureId);
      const nextWireAppearance = getWireframeAppearance(options.current.theme);
      if (wireMaterial.userData.theme !== options.current.theme) {
        wireMaterial.color.set(nextWireAppearance.color);
        wireMaterial.opacity = nextWireAppearance.opacity;
        wireMaterial.blending = nextWireAppearance.blending;
        wireMaterial.depthWrite = nextWireAppearance.depthWrite;
        wireMaterial.transparent = true;
        wireMaterial.needsUpdate = true;
        wireMaterial.userData.theme = options.current.theme;
      }
      const materialKey = `${options.current.wire ? 'w' : ''}|${options.current.theme}|${activeFeatureId ?? ''}`;

      if (materialKey !== appliedKey) {
        appliedKey = materialKey;

        group.traverse(node => {
          if (!node.isMesh) return;

          if (node.userData?.isHighlightOnly) {
            node.visible = Boolean(activeFeatureId && node.userData.featureId === activeFeatureId);
          } else if (options.current.wire) {
            node.material = wireMaterial;
          } else if (activeFeatureId && (node.userData?.featureId === activeFeatureId || node.parent?.userData?.featureId === activeFeatureId)) {
            node.material = isSelected ? selectHighlightMat : hoverHighlightMat;
          } else {
            node.material = originals.get(node.uuid) || node.material;
          }
        });
      }
      const r = view.radius * Math.sin(view.phi);
      camera.position.set(target.x + r * Math.cos(view.theta), target.y + view.radius * Math.cos(view.phi), target.z + r * Math.sin(view.theta));
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
      group.traverse(node => { if (node.geometry) node.geometry.dispose(); });
      wireMaterial.dispose();
      selectHighlightMat.dispose();
      hoverHighlightMat.dispose();
      illuminationLight.dispose();
      themeSync.dispose();
      themeSyncRef.current = null;
      renderer.dispose();
      host.replaceChildren();
    };
  }, [analysis]);

  useEffect(() => {
    themeSyncRef.current?.setAppearance({
      baseColor: modelBaseColor,
      backgroundColor: viewportBackgroundColor,
    });
  }, [modelBaseColor, viewportBackgroundColor]);

  useEffect(() => { resetViewRef.current?.(); }, [resetKey]);
  return (
    <div className="model-canvas-wrapper">
      <div className="model-canvas" ref={mount} aria-label="Interactive reconstructed 3D model" />
      {stress && <DamageHeatmapOverlay analysis={analysis} images={images} compact />}
    </div>
  );
}

function Nav() {
  const { setPage, theme, toggleTheme } = useApp();
  return (
    <nav>
      <button className="brand" onClick={() => setPage('home')}>ReForge AI</button>
      <div className="navlinks">
        <button onClick={() => setPage('workbench')}>Workbench</button>
      </div>
      <div className="nav-actions">
        <button
          className="theme-toggle-btn icon-only"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`}
          aria-label={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`}
        >
          <Icon>{theme === 'light' ? 'dark_mode' : 'light_mode'}</Icon>
        </button>
        <button className="navcta" onClick={() => setPage('upload')}>Upload Component</button>
      </div>
    </nav>
  );
}

function Landing() {
  const { setPage, theme } = useApp();
  return (
    <>
      <Nav />
      <main className="landing">
        <section className="hero">
          <GearCanvas theme={theme} />
          <div className="cad readout top-left">X: -145.22, Y: 84.10, Z: 0.00</div>
          <div className="cad readout top-right">SYS: ONLINE // REV-ENG: ACTIVE</div>
          <div className="hero-copy">
            <p className="eyebrow">INDUSTRIAL REVERSE ENGINEERING</p>
            <h1>RECONSTRUCT.<br />REFORGE.<br /><em>REMANUFACTURE.</em></h1>
            <p>Turn component images into engineering-ready geometry.</p>
            <button className="primary" onClick={() => setPage('upload')}>START REFORGE <Icon>arrow_forward</Icon></button>
          </div>
        </section>
        <section className="how">
          <p className="eyebrow">THE REFORGE WORKFLOW</p>
          <div><span>01 / CAPTURE</span><span>02 / SYNTHESIZE</span><span>03 / REBUILD</span></div>
          <button className="secondary" onClick={() => setPage('upload')}>START REFORGE <Icon>arrow_forward</Icon></button>
        </section>
      </main>
    </>
  );
}

const REFERENCE_FIELDS = [
  { key: 'outerDiameter', label: 'Outer Ø', unit: 'mm' },
  { key: 'innerDiameter', label: 'Inner Ø (bore)', unit: 'mm' },
  { key: 'height', label: 'Height / Length', unit: 'mm' },
  { key: 'thickness', label: 'Thickness / Width', unit: 'mm' },
  { key: 'teeth', label: 'Teeth', unit: 'count' },
  { key: 'module', label: 'Module', unit: 'mm' },
  { key: 'helixAngle', label: 'Helix angle', unit: 'deg' },
];

function buildReference(fields) {
  const reference = {};
  for (const { key } of REFERENCE_FIELDS) {
    const raw = fields[key];
    if (raw === '' || raw == null) continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 0) reference[key] = num;
  }
  return reference;
}

// ─── Manufacturing Intelligence Panel (T25) ───────────────────────────────────

function MfgSkeleton() {
  return (
    <div className="mfg-skeleton" aria-busy="true" aria-label="Loading manufacturing estimate">
      <div className="mfg-skel-line wide" />
      <div className="mfg-skel-line medium" />
      <div className="mfg-skel-line narrow" />
      <div className="mfg-skel-line medium" />
    </div>
  );
}

function formatINR(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function ManufacturingPanel({ analysis, onData, quantity: externalQuantity, setQuantity: externalSetQuantity }) {
  const [internalQuantity, setInternalQuantity] = useState(1);
  const quantity = externalQuantity ?? internalQuantity;
  const setQuantity = externalSetQuantity ?? setInternalQuantity;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [altOpen, setAltOpen] = useState(false);

  useEffect(() => {
    if (!analysis) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const t = setTimeout(() => {
      fetchManufacturingIntelligence(analysis, quantity)
        .then((result) => {
          if (!cancelled) {
            setData(result);
            onData?.(result);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Estimate failed.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [analysis, quantity]);

  // Insufficient-data case (backend returns { error: 'insufficient-data' } inside the 200)
  const isInsufficient = data?.error === 'insufficient-data';

  return (
    <div className="mfg-panel" aria-label="Manufacturing Intelligence">
      <div className="mfg-header">
        <span className="cad mfg-title"><Icon>receipt_long</Icon> MFG INTEL</span>
        <div className="mfg-qty-wrap">
          <label htmlFor="mfg-qty" className="mfg-qty-label">QTY</label>
          <input
            id="mfg-qty"
            className="mfg-qty-input"
            type="number"
            min="1"
            max="100000"
            step="1"
            value={quantity}
            onChange={e => {
              const v = Math.max(1, Math.min(100000, Math.round(Number(e.target.value) || 1)));
              setQuantity(v);
            }}
            aria-label="Production quantity"
          />
        </div>
      </div>

      {loading && <MfgSkeleton />}

      {!loading && error && (
        <p className="mfg-error" role="alert">
          <Icon>error_outline</Icon> {error}
        </p>
      )}

      {!loading && !error && isInsufficient && (
        <p className="mfg-insufficient">
          <Icon>info</Icon> Not enough geometry data to estimate cost. Provide clearer images or reference dimensions.
        </p>
      )}

      {!loading && !error && data && !isInsufficient && (
        <>
          {/* Cost range — primary headline */}
          <div className="mfg-section">
            <span className="mfg-label">EST. COST / UNIT</span>
            <div className="mfg-cost-range">
              ₹{formatINR(data.cost.low)}
              <span className="mfg-cost-sep">–</span>
              ₹{formatINR(data.cost.high)}
            </div>
            <div className="mfg-cost-currency">INR · per unit at qty {data.quantity}</div>
          </div>

          {/* Mass & volume */}
          <div className="mfg-section mfg-meta-row">
            <span><span className="mfg-label">MASS</span> {data.massKg.toFixed(3)} kg</span>
            <span><span className="mfg-label">VOL</span> {data.volumeCm3.toFixed(2)} cm³</span>
            <span className={`mfg-source-badge ${data.material.source === 'fallback-default' ? 'warn' : ''}`}>
              {data.material.label}
            </span>
          </div>

          {/* Process recommendation */}
          <div className="mfg-section">
            <span className="mfg-label">RECOMMENDED PROCESS</span>
            <div className="mfg-process-name">{data.process.recommended.label}</div>
            <p className="mfg-reasoning">{data.process.reasoning}</p>

            {data.process.alternatives.length > 0 && (
              <>
                <button
                  className="mfg-toggle"
                  onClick={() => setAltOpen(o => !o)}
                  aria-expanded={altOpen}
                >
                  {altOpen ? '▲' : '▶'} {data.process.alternatives.length} alternative{data.process.alternatives.length > 1 ? 's' : ''}
                </button>
                {altOpen && (
                  <ul className="mfg-alt-list">
                    {data.process.alternatives.map(alt => (
                      <li key={alt.key}>
                        <strong>{alt.label}</strong> — {alt.tradeoff}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {/* Lead time */}
          <div className="mfg-section mfg-lead">
            <span className="mfg-label">LEAD TIME</span>
            <span className="mfg-lead-value">{data.leadTime.lowDays}–{data.leadTime.highDays} working days</span>
          </div>

          {/* Cost breakdown */}
          <div className="mfg-section">
            <span className="mfg-label">BREAKDOWN (per unit)</span>
            <div className="mfg-breakdown">
              <span>Material</span><span>₹{formatINR(data.cost.breakdown.materialCostINR)}</span>
              <span>Machining</span><span>₹{formatINR(data.cost.breakdown.machiningCostINR)}</span>
              {data.cost.breakdown.toolingPerUnitINR > 0 && (
                <><span>Tooling (÷qty)</span><span>₹{formatINR(data.cost.breakdown.toolingPerUnitINR)}</span></>
              )}
              <span>Overhead (20%)</span><span>₹{formatINR(data.cost.breakdown.overheadINR)}</span>
            </div>
          </div>

          {/* Assumptions — visually de-emphasised */}
          {data.assumptions?.length > 0 && (
            <div className="mfg-assumptions">
              <button
                className="mfg-toggle"
                onClick={() => setAssumptionsOpen(o => !o)}
                aria-expanded={assumptionsOpen}
              >
                {assumptionsOpen ? '▲' : '▶'} {data.assumptions.length} assumption{data.assumptions.length > 1 ? 's' : ''} applied
              </button>
              {assumptionsOpen && (
                <ul className="mfg-assumption-list">
                  {data.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
            </div>
          )}

          <p className="mfg-disclaimer">
            Illustrative estimate · India job-shop rates (v1 placeholders). Not a real quote.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Material Comparison Panel ───────────────────────────────────────────────

const PROP_LABELS = {
  corrosionResistance: 'Corrosion',
  wearResistance: 'Wear',
  machinability: 'Machinability',
  strengthLevel: 'Strength',
};

function PropBadge({ label, level }) {
  return (
    <span className={`matcomp-prop-badge ${level}`}>
      {label}: {level.toUpperCase()}
    </span>
  );
}

function DeltaChip({ value, unit }) {
  const abs = Math.abs(value);
  const cls = value <= -15 ? 'down' : value >= 15 ? 'up' : 'flat';
  const arrow = value <= -15 ? '↓' : value >= 15 ? '↑' : '≈';
  const text = value <= -15 ? `${arrow} ${abs}% ${unit === 'weight' ? 'lighter' : 'cheaper'}`
    : value >= 15 ? `${arrow} ${abs}% ${unit === 'weight' ? 'heavier' : 'more expensive'}`
      : `${arrow} similar ${unit}`;
  return <span className={`matcomp-delta ${cls}`}>{text}</span>;
}

function ScoreBar({ score }) {
  return (
    <div className="matcomp-score-wrap" title={`Trade-off score: ${score}/100`}>
      <div className="matcomp-score-bar" style={{ width: `${score}%` }} />
      <span className="matcomp-score-label">{score}/100</span>
    </div>
  );
}

function MaterialComparisonPanel({ analysis, manufacturingIntelligence }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (!analysis || !manufacturingIntelligence || manufacturingIntelligence.error) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchMaterialAlternatives(analysis, manufacturingIntelligence)
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => { if (!cancelled) setError(err.message || 'Material comparison failed.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [analysis, manufacturingIntelligence]);

  const isInsufficient = data?.error === 'insufficient-data';

  return (
    <div className="matcomp-panel" aria-label="Material Alternatives">
      <div className="matcomp-header">
        <span className="cad matcomp-title"><Icon>layers</Icon> MATERIAL OPTIONS</span>
      </div>

      {loading && (
        <div className="mfg-skeleton" style={{ padding: '12px 10px' }} aria-busy="true">
          <div className="mfg-skel-line wide" />
          <div className="mfg-skel-line medium" />
          <div className="mfg-skel-line narrow" />
        </div>
      )}

      {!loading && error && (
        <p className="mfg-error" role="alert"><Icon>error_outline</Icon> {error}</p>
      )}

      {!loading && !error && isInsufficient && (
        <div className="matcomp-insufficient">
          <Icon>info</Icon>
          <p>Material comparison unavailable — a reliable part volume could not be estimated.</p>
        </div>
      )}

      {!loading && !error && data && !isInsufficient && (
        <>
          {/* Current material */}
          <div className="matcomp-section">
            <span className="mfg-label">
              {data.current.materialSource === 'fallback-default' ? 'CURRENT ASSUMPTION' : 'CURRENT MATERIAL'}
            </span>
            {data.current.materialSource === 'fallback-default' && (
              <p className="matcomp-fallback-warn">
                <Icon>warning</Icon> Material was not confidently identified. Comparison uses {data.current.label} as the baseline.
              </p>
            )}
            <div className="matcomp-current-card">
              <div className="matcomp-material-name">{data.current.label}</div>
              <div className="matcomp-current-stats">
                <span><span className="mfg-label">MASS</span> {data.current.massKg.toFixed(3)} kg</span>
                <span><span className="mfg-label">MAT. COST</span> ₹{formatINR(data.current.materialCostINR)}</span>
              </div>
            </div>
          </div>

          {/* Alternative cards */}
          {data.alternatives.length > 0 && (
            <div className="matcomp-section">
              <span className="mfg-label">COMPARE MATERIALS</span>
              <div className="matcomp-alt-list">
                {data.alternatives.map(alt => (
                  <div key={alt.key} className="matcomp-alt-card">
                    <div className="matcomp-alt-header">
                      <span className="matcomp-material-name">{alt.label}</span>
                      {alt.badge && <span className="matcomp-badge">{alt.badge}</span>}
                    </div>
                    <div className="matcomp-alt-stats">
                      <span>{alt.massKg.toFixed(3)} kg</span>
                      <span>₹{formatINR(alt.materialCostINR)}</span>
                    </div>
                    <div className="matcomp-deltas">
                      <DeltaChip value={alt.weightChangePercent} unit="weight" />
                      <DeltaChip value={alt.materialCostChangePercent} unit="cost" />
                    </div>
                    <div className="matcomp-props">
                      {Object.entries(PROP_LABELS).map(([key, label]) =>
                        alt.properties[key] ? (
                          <PropBadge key={key} label={label} level={alt.properties[key]} />
                        ) : null
                      )}
                    </div>
                    <p className="matcomp-why"><span className="mfg-label">WHY?</span> {alt.whyConsider}</p>
                    <p className="matcomp-tradeoff-text">{alt.tradeoff}</p>
                    <ScoreBar score={alt.tradeoffScore} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comparison table */}
          <div className="matcomp-section">
            <button className="mfg-toggle" onClick={() => setTableOpen(o => !o)} aria-expanded={tableOpen}>
              {tableOpen ? '▲' : '▶'} Comparison table
            </button>
            {tableOpen && (
              <div className="matcomp-table-wrap">
                <table className="matcomp-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Mass</th>
                      <th>Mat. Cost</th>
                      <th>Mass Δ</th>
                      <th>Cost Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="matcomp-table-current">
                      <td>{data.current.label}</td>
                      <td>{data.current.massKg.toFixed(2)} kg</td>
                      <td>₹{formatINR(data.current.materialCostINR)}</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                    {data.alternatives.map(alt => (
                      <tr key={alt.key}>
                        <td>{alt.label}</td>
                        <td>{alt.massKg.toFixed(2)} kg</td>
                        <td>₹{formatINR(alt.materialCostINR)}</td>
                        <td className={alt.weightChangePercent <= -15 ? 'matcomp-td-down' : alt.weightChangePercent >= 15 ? 'matcomp-td-up' : ''}>
                          {alt.weightChangePercent > 0 ? '+' : ''}{alt.weightChangePercent}%
                        </td>
                        <td className={alt.materialCostChangePercent <= -15 ? 'matcomp-td-down' : alt.materialCostChangePercent >= 15 ? 'matcomp-td-up' : ''}>
                          {alt.materialCostChangePercent > 0 ? '+' : ''}{alt.materialCostChangePercent}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="mfg-disclaimer">
            Estimates for comparison only · Based on current geometry estimate · Not engineering-certified.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Feature Identification Panel ──────────────────────────────────────────

const GEOMETRY_SOURCE_LABELS = {
  image_recipe: 'IMAGE RECIPE',
  image_recipe_refined: 'IMAGE RECIPE (REFINED)',
  template_gear: 'TEMPLATE GEAR',
  template_flange: 'TEMPLATE FLANGE',
  template_shaft: 'TEMPLATE SHAFT',
  template_generic: 'TEMPLATE',
  template_fallback: 'TEMPLATE FALLBACK',
  vision_template: 'VISION TEMPLATE',
};

function FeatureConfidenceBadge({ confidence }) {
  if (typeof confidence !== 'number') return null;
  const level = confidence >= 0.85 ? 'high' : confidence >= 0.65 ? 'medium' : 'low';
  const label = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
  return <span className={`feature-badge ${level}`} title={`Confidence: ${Math.round(confidence * 100)}%`}>{label}</span>;
}

function FeatureDimChip({ metadata }) {
  if (!metadata || typeof metadata !== 'object') return null;
  const items = [];
  if (metadata.diameter != null) items.push(`Ø${metadata.diameter} mm`);
  if (metadata.count != null && metadata.count > 1) items.push(`${metadata.count} holes`);
  if (metadata.teeth != null) items.push(`${metadata.teeth} teeth`);
  if (metadata.module != null) items.push(`M${metadata.module}`);
  if (metadata.depth != null) items.push(`L:${metadata.depth}mm`);
  if (metadata.maxStep != null) items.push(`Step:${metadata.maxStep.toFixed(1)}mm`);

  if (!items.length) return null;
  return (
    <div className="feature-dim-chips">
      {items.map((it, idx) => (
        <span key={idx} className="feature-dim-chip">{it}</span>
      ))}
    </div>
  );
}

function FeatureIdentificationPanel({
  features,
  selectedFeatureId,
  hoveredFeatureId,
  onSelectFeature,
  onHoverFeature,
}) {
  const hasLowConfidence = features.some(f => f.confidence < 0.65);

  return (
    <div className="features-panel" aria-label="Detected Engineering Features">
      <div className="features-header">
        <span className="cad features-title">
          <Icon>center_focus_strong</Icon> DETECTED FEATURES
        </span>
        <span className="features-count-badge">{features.length}</span>
      </div>

      {features.length === 0 ? (
        <div className="features-empty">
          <Icon>info</Icon>
          <p>No individual engineering features could be identified from the current analysis.</p>
        </div>
      ) : (
        <>
          {hasLowConfidence && (
            <div className="features-warn">
              <Icon>warning</Icon>
              <span>Some features are uncertain. Review in 3D before making manufacturing decisions.</span>
            </div>
          )}

          <div className="features-list" role="list">
            {features.map(f => {
              const isSelected = selectedFeatureId === f.id;
              const isHovered = hoveredFeatureId === f.id && !isSelected;
              const hasGeometry = Boolean(f.geometryRef);

              return (
                <div
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  aria-label={`Select ${f.label}`}
                  className={`feature-card ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''} ${!hasGeometry ? 'no-mesh' : ''}`}
                  onClick={() => onSelectFeature(isSelected ? null : f.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectFeature(isSelected ? null : f.id);
                    }
                  }}
                  onMouseEnter={() => onHoverFeature(f.id)}
                  onMouseLeave={() => onHoverFeature(null)}
                >
                  <div className="feature-card-header">
                    <div className="feature-card-title-row">
                      <span className={`feature-status-dot ${isSelected ? 'active' : ''}`} />
                      <span className="feature-card-label">{f.label}</span>
                    </div>
                    {isSelected && <span className="feature-selected-tag">SELECTED</span>}
                  </div>

                  <FeatureDimChip metadata={f.metadata} />

                  <p className="feature-desc">{f.description}</p>

                  <div className="feature-card-footer">
                    <FeatureConfidenceBadge confidence={f.confidence} />
                    {!hasGeometry ? (
                      <span className="feature-no-mesh-tag" title="Detected in analysis but not separately selectable in 3D">
                        Analysis only
                      </span>
                    ) : (
                      <span className="feature-3d-tag">
                        <Icon>view_in_ar</Icon> 3D Highlight
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mfg-disclaimer">
            Click any feature to highlight in 3D · Hover for quick preview.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Automatic Engineering Drawing Viewer Modal ────────────────────────────

function EngineeringDrawingModal({ analysis, manufacturingIntelligence, onClose, isWorkWindow = false }) {
  const [revision, setRevision] = useState('A');
  const [viewFilter, setViewFilter] = useState('all');
  const [showDimensions, setShowDimensions] = useState(true);
  const [showCenterlines, setShowCenterlines] = useState(true);
  const [showHiddenLines, setShowHiddenLines] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [exporting, setExporting] = useState(false);
  const [activeDimTooltip, setActiveDimTooltip] = useState(null);

  const drawingModel = useMemo(() => {
    return buildDrawingModel({
      analysis,
      manufacturingIntelligence,
      revision,
    });
  }, [analysis, manufacturingIntelligence, revision]);

  const svgMarkup = useMemo(() => {
    return renderDrawingToSvg(drawingModel, {
      showDimensions,
      showCenterlines,
      showHiddenLines,
      viewFilter,
    });
  }, [drawingModel, showDimensions, showCenterlines, showHiddenLines, viewFilter]);

  const handleExportSvg = () => {
    exportSvg(svgMarkup, `${drawingModel.drawingId}-${drawingModel.partName.toLowerCase().replace(/[\s/]+/g, '-')}-rev${revision}.svg`);
  };

  const handleExportPng = async () => {
    setExporting(true);
    try {
      await exportPng(svgMarkup, `${drawingModel.drawingId}-${drawingModel.partName.toLowerCase().replace(/[\s/]+/g, '-')}-rev${revision}.png`, 3);
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      await exportPdf(svgMarkup, drawingModel, `${drawingModel.drawingId}-${drawingModel.partName.toLowerCase().replace(/[\s/]+/g, '-')}-rev${revision}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.88;
    setZoom((z) => Math.max(0.4, Math.min(4.0, z * factor)));
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.cad-dim')) {
      const dimEl = e.target.closest('.cad-dim');
      const source = dimEl.getAttribute('data-source');
      const conf = dimEl.getAttribute('data-confidence');
      const dimId = dimEl.getAttribute('data-dim-id');
      setActiveDimTooltip({
        x: e.clientX,
        y: e.clientY,
        source: source === 'geometryRecipe' ? 'Geometry Recipe (Verified)' : 'AI-Estimated Analysis',
        confidence: conf ? `${Math.round(Number(conf) * 100)}%` : '80%',
        isEstimated: source !== 'geometryRecipe',
        id: dimId,
      });
      return;
    }
    setActiveDimTooltip(null);
    setIsPanning(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e) => {
    if (!isPanning) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setActiveDimTooltip(null);
  };

  const content = (
    <div className={`drawing-modal-content ${isWorkWindow ? 'work-window-content' : ''}`}>
      <header className="drawing-modal-header">
        <div className="drawing-title-row">
          <button className="back drawing-back-btn" onClick={onClose} title="Dock to 3D Viewport">
            <Icon>view_in_ar</Icon> Dock to 3D Workbench
          </button>
          <span className="drawing-dwg-badge">{drawingModel.drawingId} // REV {revision}</span>
          <span className="drawing-part-name">{drawingModel.partName}</span>
        </div>

        <div className="drawing-export-group">
          <button className="drawing-export-btn" disabled={exporting} onClick={handleExportSvg}>
            <Icon>download</Icon> SVG
          </button>
          <button className="drawing-export-btn" disabled={exporting} onClick={handleExportPng}>
            <Icon>image</Icon> PNG (3x)
          </button>
          <button className="drawing-export-btn primary" disabled={exporting} onClick={handleExportPdf}>
            <Icon>picture_as_pdf</Icon> PDF (A4)
          </button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="drawing-toolbar">
        <div className="drawing-toolbar-section">
          <span className="drawing-toolbar-label">VIEW:</span>
          {['all', 'front', 'top', 'side'].map((v) => (
            <button
              key={v}
              className={`drawing-pill ${viewFilter === v ? 'active' : ''}`}
              onClick={() => setViewFilter(v)}
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="drawing-toolbar-section">
          <span className="drawing-toolbar-label">LAYERS:</span>
          <label className="drawing-toggle-label">
            <input
              type="checkbox"
              checked={showDimensions}
              onChange={(e) => setShowDimensions(e.target.checked)}
            />
            <span>Dims</span>
          </label>
          <label className="drawing-toggle-label">
            <input
              type="checkbox"
              checked={showCenterlines}
              onChange={(e) => setShowCenterlines(e.target.checked)}
            />
            <span>Centerlines</span>
          </label>
          <label className="drawing-toggle-label">
            <input
              type="checkbox"
              checked={showHiddenLines}
              onChange={(e) => setShowHiddenLines(e.target.checked)}
            />
            <span>Hidden</span>
          </label>
        </div>

        <div className="drawing-toolbar-section">
          <span className="drawing-toolbar-label">REV:</span>
          <input
            type="text"
            maxLength={3}
            className="drawing-rev-input"
            value={revision}
            onChange={(e) => setRevision(e.target.value.toUpperCase())}
          />
        </div>

        <div className="drawing-toolbar-section drawing-zoom-section">
          <button className="drawing-zoom-btn" title="Zoom Out" onClick={() => setZoom((z) => Math.max(0.4, z * 0.85))}>
            <Icon>remove</Icon>
          </button>
          <span className="drawing-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="drawing-zoom-btn" title="Zoom In" onClick={() => setZoom((z) => Math.min(4.0, z * 1.15))}>
            <Icon>add</Icon>
          </button>
          <button className="drawing-zoom-btn" title="Fit to Page" onClick={resetView}>
            <Icon>fit_screen</Icon> Fit
          </button>
        </div>
      </div>

      {/* AI Estimation Banner */}
      {drawingModel.isEstimated && (
        <div className="drawing-banner" role="alert">
          <Icon>warning</Icon>
          <span>
            <strong>AI-Estimated Geometry:</strong> Dimensions and profile were reconstructed from imagery. Verify critical dimensions and tolerances before manufacturing.
          </span>
        </div>
      )}

      {/* Main Canvas Viewport */}
      <div
        className={`drawing-viewport-wrap ${isPanning ? 'panning' : ''}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="drawing-sheet-container"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />

        {activeDimTooltip && (
          <div
            className="drawing-dim-tooltip"
            style={{ left: activeDimTooltip.x + 12, top: activeDimTooltip.y + 12 }}
          >
            <div className="drawing-tooltip-title">Dimension Inspection</div>
            <div className="drawing-tooltip-row">
              <span>Source:</span> <strong>{activeDimTooltip.source}</strong>
            </div>
            <div className="drawing-tooltip-row">
              <span>Confidence:</span> <strong>{activeDimTooltip.confidence}</strong>
            </div>
            {activeDimTooltip.isEstimated && (
              <div className="drawing-tooltip-warn">Verify dimension before production tooling.</div>
            )}
          </div>
        )}
      </div>

      <footer className="drawing-modal-footer">
        <span>ISO A4 Landscape · Drag to Pan · Scroll to Zoom · Click dimensions to inspect confidence</span>
      </footer>
    </div>
  );

  if (isWorkWindow) {
    return <div className="work-window drawing-work-window">{content}</div>;
  }

  return (
    <div className="drawing-modal-backdrop" role="dialog" aria-modal="true" aria-label="Engineering Drawing Generator">
      {content}
    </div>
  );
}

function Upload() {
  const {
    machineryState,
    setMachineryState,
    setImages,
    setPage,
    stage,
    reconstructionReference,
    setReconstructionReference,
    reconstructionProgress,
    startReconstruction,
    cancelReconstruction,
    retryReconstruction,
  } = useApp();

  const [activeUploadSlot, setActiveUploadSlot] = useState('primary'); // 'primary' | 'companion' | 'surroundings'
  const [error, setError] = useState('');
  const reference = reconstructionReference;
  const setReference = setReconstructionReference;
  const busy = stage === 'analysing';

  const inputPrimary = useRef(null);
  const inputCompanion = useRef(null);
  const inputSurroundings = useRef(null);

  const primary = machineryState?.primaryGear;
  const companion = machineryState?.companionGear;
  const surroundings = machineryState?.machineryContext;

  const addFilesToSlot = (slot, files) => {
    if (!files || !files.length) return;
    const accepted = [...files].filter((f) => (f.type ? f.type.startsWith('image/') : true) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.name || ''));
    if (!accepted.length) {
      setError('Use image files (PNG, JPG, WEBP, or GIF).');
      return;
    }
    setError('');

    if (slot === 'primary') {
      setMachineryState((prevState) => {
        const targetId = prevState?.primaryGear?.id || 'comp-primary-gear';
        const next = addImagesToComponent(prevState, targetId, accepted);
        setImages(next.primaryGear?.images || []);
        return next;
      });
    } else if (slot === 'companion') {
      setMachineryState((prevState) => {
        if (!prevState.companionGear) {
          return addCompanionFromImages(prevState, accepted, 'Companion Gear');
        }
        return addImagesToComponent(prevState, prevState.companionGear.id, accepted);
      });
    } else if (slot === 'surroundings') {
      setMachineryState((prevState) => {
        return addImagesToComponent(prevState, 'environment-context', accepted);
      });
    }
  };

  const reconstruct = () => {
    if (!(primary?.images?.length)) {
      setError('Add at least one Primary Gear image to start reconstruction.');
      return;
    }
    setError('');
    startReconstruction();
  };

  const primaryCount = primary?.images?.length || 0;
  const companionCount = companion?.images?.length || 0;
  const surroundingsCount = surroundings?.images?.length || 0;

  return (
    <div className="upload-page-wrapper">
      <Nav />
      <main className="upload-page">
        <button className="back" onClick={() => setPage('home')}>
          <Icon>arrow_back</Icon> Back to brief
        </button>
        <header>
          <p className="eyebrow">MACHINERY CONTEXT / SYNTHESIS</p>
          <h1>Upload Machinery &amp; Gear Views</h1>
          <p>
            ReForge reconstructs the Primary Gear in full context with its Companion Gear and surrounding machinery.
          </p>
        </header>

        {/* Upload Slots Tab Switcher */}
        <div className="copilot-tab-bar" style={{ marginBottom: '12px', borderRadius: '3px 3px 0 0' }}>
          <button
            className={`copilot-tab-btn ${activeUploadSlot === 'primary' ? 'active' : ''}`}
            onClick={() => setActiveUploadSlot('primary')}
          >
            <span className="role-tag primary" style={{ fontSize: '7px' }}>PRIMARY</span>
            Primary Gear ({primaryCount})
          </button>
          <button
            className={`copilot-tab-btn ${activeUploadSlot === 'companion' ? 'active' : ''}`}
            onClick={() => setActiveUploadSlot('companion')}
          >
            <span className="role-tag companion" style={{ fontSize: '7px' }}>COMPANION</span>
            Companion Gear ({companionCount})
          </button>
          <button
            className={`copilot-tab-btn ${activeUploadSlot === 'surroundings' ? 'active' : ''}`}
            onClick={() => setActiveUploadSlot('surroundings')}
          >
            <span className="role-tag context" style={{ fontSize: '7px' }}>SURROUNDINGS</span>
            Machinery ({surroundingsCount})
          </button>
        </div>

        {activeUploadSlot === 'primary' && (
          <section className="upload-grid">
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFilesToSlot('primary', e.dataTransfer.files);
              }}
            >
              <Icon>add_photo_alternate</Icon>
              <h2>Drop Primary Gear images here</h2>
              <p>Main component being reconstructed · PNG, JPG, WEBP or GIF</p>
              <button className="secondary" onClick={() => inputPrimary.current.click()}>
                SELECT PRIMARY IMAGES
              </button>
              <input
                ref={inputPrimary}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addFilesToSlot('primary', e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <aside className="input-panel">
              <span className="cad">PRIMARY GEAR SPECS</span>
              <p>Include top, side, and tooth engagement angles.</p>
              <div className="ref-block">
                <span className="cad">
                  KNOWN DIMENSIONS <small className="ref-optional">(OPTIONAL)</small>
                </span>
                <p className="ref-hint">Fill any you know to calibrate the 3D model.</p>
                <div className="ref-grid">
                  {REFERENCE_FIELDS.map(({ key, label, unit }) => (
                    <label key={key} className="ref-field">
                      <span>{label}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="—"
                        value={reference[key] ?? ''}
                        onChange={(e) => setReference((prev) => ({ ...prev, [key]: e.target.value }))}
                        aria-label={label}
                      />
                      <small>{unit}</small>
                    </label>
                  ))}
                </div>
              </div>
            </aside>
          </section>
        )}

        {activeUploadSlot === 'companion' && (
          <section className="upload-grid">
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFilesToSlot('companion', e.dataTransfer.files);
              }}
            >
              <Icon>sync</Icon>
              <h2>Drop Companion Gear images here</h2>
              <p>Mating gear directly interacting with the Primary Gear (Optional)</p>
              <button className="secondary" onClick={() => inputCompanion.current.click()}>
                SELECT COMPANION IMAGES
              </button>
              <input
                ref={inputCompanion}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addFilesToSlot('companion', e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <aside className="input-panel">
              <span className="cad">COMPANION GEAR INSIGHTS</span>
              <p>
                Providing mating gear images unlocks center distance calibration, gear ratio kinematics, and tooth contact stress analysis.
              </p>
            </aside>
          </section>
        )}

        {activeUploadSlot === 'surroundings' && (
          <section className="upload-grid">
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFilesToSlot('surroundings', e.dataTransfer.files);
              }}
            >
              <Icon>precision_manufacturing</Icon>
              <h2>Drop Machinery / Assembly Context images here</h2>
              <p>Machine view, shaft alignments, bearings, or gearbox housing (Optional)</p>
              <button className="secondary" onClick={() => inputSurroundings.current.click()}>
                SELECT MACHINERY IMAGES
              </button>
              <input
                ref={inputSurroundings}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addFilesToSlot('surroundings', e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <aside className="input-panel">
              <span className="cad">ENVIRONMENTAL CONTEXT</span>
              <p>
                Gives the AI Copilot full situational awareness for housing constraints, shaft fits, lubrication, and vibration origins.
              </p>
            </aside>
          </section>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {busy && <ProgressStepper index={1} />}
        <ReconstructionProgress
          progress={reconstructionProgress}
          onCancel={cancelReconstruction}
          onRetry={retryReconstruction}
        />

        {/* Previews Area */}
        <section className="preview-area">
          <div className="preview-list-wrap">
            <p className="eyebrow" style={{ margin: '0 0 6px' }}>
              PRIMARY ({primaryCount}) · COMPANION ({companionCount}) · SURROUNDINGS ({surroundingsCount})
            </p>
            <div className="previews">
              {primary?.images?.map((image) => (
                <figure key={image.id}>
                  {image.url ? <img src={image.url} alt={image.name} /> : null}
                  <button
                    aria-label={`Remove ${image.name}`}
                    onClick={() => {
                      const next = removeImageFromComponent(machineryState, primary.id, image.id);
                      setMachineryState(next);
                      setImages(next.primaryGear?.images || []);
                    }}
                  >
                    <Icon>close</Icon>
                  </button>
                  <figcaption>Primary: {image.name}</figcaption>
                </figure>
              ))}
              {companion?.images?.map((image) => (
                <figure key={image.id}>
                  {image.url ? <img src={image.url} alt={image.name} /> : null}
                  <button
                    aria-label={`Remove ${image.name}`}
                    onClick={() => {
                      const next = removeImageFromComponent(machineryState, companion.id, image.id);
                      setMachineryState(next);
                    }}
                  >
                    <Icon>close</Icon>
                  </button>
                  <figcaption>Companion: {image.name}</figcaption>
                </figure>
              ))}
              {surroundings?.images?.map((image) => (
                <figure key={image.id}>
                  {image.url ? <img src={image.url} alt={image.name} /> : null}
                  <button
                    aria-label={`Remove ${image.name}`}
                    onClick={() => {
                      const next = removeImageFromComponent(machineryState, 'comp-machinery-surroundings', image.id);
                      setMachineryState(next);
                    }}
                  >
                    <Icon>close</Icon>
                  </button>
                  <figcaption>Machinery: {image.name}</figcaption>
                </figure>
              ))}
              {!primaryCount && !companionCount && !surroundingsCount && (
                <p className="empty">No component images selected yet.</p>
              )}
            </div>
          </div>

          <div className="upload-actions">
            <button
              className="primary"
              disabled={busy || !primaryCount}
              onClick={reconstruct}
            >
              {busy ? 'SYNTHESIZING MACHINERY…' : 'CREATE 3D MODEL'} <Icon>precision_manufacturing</Icon>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
function WhatIfSimulator({
  analysis,
  scenarioParams,
  setScenarioParams,
  recommendations = [],
  deselectedRecommendations = {},
  onToggleRecommendation,
  onResetRecommendations,
  onConfirm,
  isGeometryValid,
  geometryError,
  warnings,
  impactStatus,
  materialVolumeImpact,
  ready,
  onOpenReport,
}) {
  if (!ready || !analysis) {
    return (
      <div className="whatif-container">
        <div className="whatif-empty">
          <Icon>tune</Icon>
          <p>No active component analysis.<br />Run synthesis to unlock the What-If Simulator.</p>
        </div>
      </div>
    );
  }

  const availableParams = PARAM_DEFINITIONS.filter(def => isParamActive(def, analysis));


  const hasModifications = Object.keys(scenarioParams).length > 0;
  const selectedRecommendationCount = recommendations.filter(
    rec => !deselectedRecommendations[rec.key]
  ).length;
  const confirmCount = hasModifications ? selectedRecommendationCount + Object.keys(scenarioParams).length : 0;

  const handleParamChange = (key, rawValue, isInteger) => {
    const num = isInteger ? parseInt(rawValue, 10) : parseFloat(rawValue);
    if (isNaN(num)) return;
    setScenarioParams(prev => ({ ...prev, [key]: num }));
  };

  const handleReset = () => {
    setScenarioParams({});
    onResetRecommendations?.();
  };

  return (
    <div className="whatif-container">
      <div className="whatif-header">
        <h3><Icon>tune</Icon> ENGINEERING WHAT-IF</h3>
        <p>Modify a design parameter to see engineering impact and related-value recommendations. The 3D model changes only after confirmation.</p>
      </div>

      {!isGeometryValid && (
        <div className="whatif-alert-invalid" role="alert">
          <div className="alert-head">
            <Icon>error</Icon>
            <strong>INVALID GEOMETRY</strong>
          </div>
          <p>{geometryError}</p>
        </div>
      )}

      <div className="whatif-impact-card">
        <div className="impact-top">
          <span className="cad">SCENARIO IMPACT</span>
          <span className={`impact-badge impact-${impactStatus.toLowerCase().replace(/\s+/g, '-')}`}>
            {impactStatus}
          </span>
        </div>
        <p className="impact-note">
          {impactStatus === 'INVALID'
            ? 'Scenario exceeds valid geometric constraints.'
            : impactStatus === 'STABLE'
              ? 'Modifications within baseline envelope (<5% deviation).'
              : impactStatus === 'REVIEW'
                ? 'Interface or moderate dimensional change (5–15%). Engineering check advised.'
                : 'Significant deviation from baseline (>15%). Rigorous verification required.'}
        </p>
      </div>

      {availableParams.length > 0 ? (
        <div className="params-list">
          {availableParams.map(def => {
            const baselineVal = getParameterValue(analysis, def.key);
            const currentVal = scenarioParams[def.key] ?? baselineVal;
            const diff = currentVal - baselineVal;
            const pct = baselineVal !== 0 ? (diff / baselineVal) * 100 : 0;
            const isModified = scenarioParams[def.key] !== undefined && Math.abs(diff) > 0.0001;
            const recommendation = recommendations.find(rec => rec.key === def.key);
            const recommendationSelected = recommendation && !deselectedRecommendations[recommendation.key];

            const sliderMin = def.min !== undefined ? Math.min(def.min, Math.floor(baselineVal * 0.2)) : Math.max(0.1, Math.floor(baselineVal * 0.2));
            const sliderMax = Math.max(def.max || Math.ceil(baselineVal * 2.5), Math.ceil(baselineVal + 20));

            const sign = diff > 0 ? '+' : '';
            const diffFormatted = def.isInteger ? `${sign}${diff} ${def.unit}` : `${sign}${diff.toFixed(1)} ${def.unit}`;
            const pctFormatted = `${sign}${pct.toFixed(1)}%`;

            return (
              <div
                key={def.key}
                className={`param-card ${isModified ? 'param-modified' : ''} ${recommendation ? 'param-recommended' : ''}`}
              >
                <div className="param-top">
                  <span className="param-name">{def.label}</span>
                  {isModified ? (
                    <span className={`param-delta ${diff > 0 ? 'delta-pos' : 'delta-neg'}`}>
                      {diffFormatted} / {pctFormatted}
                    </span>
                  ) : (
                    <span className="param-delta delta-zero">BASELINE</span>
                  )}
                </div>

                <div className="param-readout-row">
                  <div className="readout-col">
                    <span className="cad-label">BASELINE</span>
                    <span className="readout-val base-val">{baselineVal} <small>{def.unit}</small></span>
                  </div>
                  <Icon>arrow_forward</Icon>
                  <div className="readout-col">
                    <span className="cad-label">SCENARIO</span>
                    <span className="readout-val scen-val">{currentVal} <small>{def.unit}</small></span>
                  </div>
                </div>

                {recommendation && (
                  <label className={`param-recommendation ${recommendationSelected ? 'is-selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={Boolean(recommendationSelected)}
                      onChange={() => onToggleRecommendation?.(recommendation.key)}
                      aria-label={`Apply recommended ${def.label} value ${recommendation.value} ${def.unit}`}
                    />
                    <Icon>warning</Icon>
                    <span className="recommendation-copy">
                      <span className="recommendation-label">
                        RECOMMENDED {recommendation.value} <small>{def.unit}</small>
                      </span>
                      <span className="recommendation-reason">{recommendation.reason}</span>
                    </span>
                  </label>
                )}

                <div className="param-slider-row">
                  <input
                    type="range"
                    className="param-slider"
                    min={sliderMin}
                    max={sliderMax}
                    step={def.step}
                    value={currentVal}
                    onChange={e => handleParamChange(def.key, e.target.value, def.isInteger)}
                    aria-label={`Adjust ${def.label} scenario value`}
                  />
                  <input
                    type="number"
                    className="param-input"
                    min={sliderMin}
                    max={sliderMax}
                    step={def.step}
                    value={currentVal}
                    onChange={e => handleParamChange(def.key, e.target.value, def.isInteger)}
                    aria-label={`Exact value for ${def.label}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty">No modifiable dimensions identified for this component.</p>
      )}

      {materialVolumeImpact && (
        <div className="whatif-volume-card">
          <div className="volume-head">
            <span className="cad">APPROX. MATERIAL VOLUME</span>
            <span className="volume-delta">{materialVolumeImpact.deltaCm3} cm³ ({materialVolumeImpact.pct})</span>
          </div>
          <div className="volume-readout">
            <span>{materialVolumeImpact.baselineCm3} cm³</span>
            <Icon>arrow_forward</Icon>
            <span className="volume-scen">{materialVolumeImpact.scenarioCm3} cm³</span>
          </div>
          <small className="volume-disclaimer">Annular/cylindrical envelope estimate. Requires engineering verification.</small>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="whatif-warnings-card">
          <span className="cad">ENGINEERING WARNINGS</span>
          <ul className="warnings-list">
            {warnings.map((w, idx) => (
              <li key={idx} className="warning-item">
                <Icon>warning</Icon>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="whatif-actions">
        <button
          className="btn-reset-scenario"
          disabled={!hasModifications}
          onClick={handleReset}
          aria-label="Reset scenario to baseline"
        >
          <Icon>restart_alt</Icon> RESET SCENARIO
        </button>
        <button
          type="button"
          className="btn-confirm-scenario"
          disabled={!hasModifications || !isGeometryValid}
          onClick={onConfirm}
          aria-label="Confirm and apply selected scenario changes to the 3D model"
          title={!isGeometryValid ? 'Resolve invalid geometry before applying changes.' : undefined}
        >
          <Icon>check_circle</Icon> CONFIRM CHANGES{confirmCount ? ` (${confirmCount})` : ''}
        </button>
        <button
          type="button"
          className="btn-report-action"
          onClick={onOpenReport}
          aria-label="View Engineering Decision Report"
        >
          <Icon>description</Icon> DECISION REPORT
        </button>
      </div>
    </div>
  );
}

function EngineeringReportModal({
  analysis,
  scenarioParams,
  isGeometryValid,
  geometryError,
  warnings,
  impactStatus,
  materialVolumeImpact,
  images,
  onClose,
  isWorkWindow = false,
}) {
  const label = resolveLabel(analysis);
  const conf = typeof analysis?.confidence === 'number' ? Math.round(analysis.confidence * 100) : null;
  const hasModifications = Object.keys(scenarioParams).length > 0;
  const timestamp = useMemo(() => new Date().toLocaleString(), []);

  const availableParams = PARAM_DEFINITIONS.filter(def => isParamActive(def, analysis));

  const hasOD = isParamActive({ key: 'outerDiameter', isDim: true }, analysis) || typeof scenarioParams.outerDiameter === 'number';
  const hasID = isParamActive({ key: 'innerDiameter', isDim: true }, analysis) || typeof scenarioParams.innerDiameter === 'number';
  const hasTeeth = isParamActive({ key: 'teeth', isDim: false }, analysis) || typeof scenarioParams.teeth === 'number';

  const handlePrint = () => {
    window.print();
  };

  const content = (
    <div className={`report-modal ${isWorkWindow ? 'work-window-report-modal' : ''}`} onClick={e => e.stopPropagation()}>
      <div className="report-toolbar">
        <div className="report-toolbar-title">
          <Icon>description</Icon>
          <span>ENGINEERING DECISION REPORT</span>
        </div>
        <div className="report-toolbar-actions">
          <button className="primary btn-print" onClick={handlePrint}>
            <Icon>print</Icon> PRINT / SAVE PDF
          </button>
          {isWorkWindow ? (
            <button className="secondary btn-close-report" onClick={onClose} title="Dock to 3D Viewport">
              <Icon>view_in_ar</Icon> Dock to 3D Workbench
            </button>
          ) : (
            <button className="secondary btn-close-report" onClick={onClose} aria-label="Close report">
              <Icon>close</Icon>
            </button>
          )}
        </div>
      </div>

      <article className="report-paper">
        {/* Header */}
        <header className="report-header">
          <div className="report-brand-row">
            <div>
              <h1 className="report-brand">REFORGE AI</h1>
              <p className="report-doc-type">ENGINEERING DECISION & AUDIT REPORT</p>
            </div>
            <div className="report-meta-col">
              <span className="cad">DOC REF: RF-{Math.abs(label.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(16).toUpperCase().padStart(6, '0')}</span>
              <span className="report-date">GENERATED: {timestamp}</span>
              <span className={`report-state-chip ${hasModifications ? 'chip-scenario' : 'chip-baseline'}`}>
                {hasModifications ? 'STATE: WHAT-IF SCENARIO' : 'STATE: BASELINE'}
              </span>
            </div>
          </div>
          <div className="report-title-row">
            <h2>{label}</h2>
            {conf != null && <span className="report-conf-badge">CONFIDENCE: {conf}%</span>}
          </div>
        </header>

        {/* Section 1: Component Identification */}
        <section className="report-section">
          <h3 className="section-title"><Icon>category</Icon> 1. COMPONENT IDENTIFICATION</h3>
          <div className="report-grid-2">
            <div className="report-kv-card">
              <span className="kv-label">CLASSIFICATION</span>
              <span className="kv-value">{label}</span>
            </div>
            {analysis?.componentType && analysis.componentType.toLowerCase() !== 'other' && (
              <div className="report-kv-card">
                <span className="kv-label">RAW COMPONENT TYPE</span>
                <span className="kv-value">{analysis.componentType}</span>
              </div>
            )}
            {analysis?.geometryType ? (
              <div className="report-kv-card">
                <span className="kv-label">GEOMETRY MODEL TYPE</span>
                <span className="kv-value">{analysis.geometryType}</span>
              </div>
            ) : null}
            {analysis?.materialEstimate && analysis.materialEstimate.toLowerCase() !== 'unknown' ? (
              <div className="report-kv-card">
                <span className="kv-label">MATERIAL ESTIMATE</span>
                <span className="kv-value">{analysis.materialEstimate}</span>
              </div>
            ) : null}
            {analysis?.manufacturingProcess && analysis.manufacturingProcess.toLowerCase() !== 'unknown' ? (
              <div className="report-kv-card">
                <span className="kv-label">MANUFACTURING PROCESS</span>
                <span className="kv-value">{analysis.manufacturingProcess}</span>
              </div>
            ) : null}
            <div className="report-kv-card">
              <span className="kv-label">STAGED VIEWS</span>
              <span className="kv-value">{images?.length || 1} View{images?.length === 1 ? '' : 's'}</span>
            </div>
          </div>

          {Array.isArray(analysis?.features) && analysis.features.length > 0 ? (
            <div className="report-features-block">
              <span className="kv-label">IDENTIFIED FEATURES</span>
              <div className="feature-tags">
                {analysis.features.map((feat, i) => (
                  <span key={i} className="feature-tag">{feat}</span>
                ))}
              </div>
            </div>
          ) : null}

          {analysis?.reasoning ? (
            <div className="report-text-block">
              <span className="kv-label">ANALYSIS REASONING</span>
              <p>{analysis.reasoning}</p>
            </div>
          ) : null}

          {Array.isArray(analysis?.uncertainties) && analysis.uncertainties.length > 0 ? (
            <div className="report-text-block text-block-uncertainty">
              <span className="kv-label">MEASUREMENT UNCERTAINTIES</span>
              <ul>
                {analysis.uncertainties.map((unc, i) => (
                  <li key={i}>{unc}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* Section 2: Dimension Summary & Data Provenance */}
        <section className="report-section">
          <h3 className="section-title"><Icon>straighten</Icon> 2. DIMENSION SUMMARY & DATA PROVENANCE</h3>
          {availableParams.length > 0 ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th>PARAMETER</th>
                  <th>BASELINE</th>
                  <th>BASELINE PROVENANCE</th>
                  {hasModifications && <th>SCENARIO VALUE</th>}
                  {hasModifications && <th>CHANGE / DELTA</th>}
                  {hasModifications && <th>SCENARIO PROVENANCE</th>}
                </tr>
              </thead>
              <tbody>
                {availableParams.map(def => {
                  const baseVal = getParameterValue(analysis, def.key);
                  const scenVal = scenarioParams[def.key] ?? baseVal;
                  const diff = scenVal - baseVal;
                  const pct = baseVal !== 0 ? (diff / baseVal) * 100 : 0;
                  const isMod = scenarioParams[def.key] !== undefined && Math.abs(diff) > 0.0001;
                  const sign = diff > 0 ? '+' : '';
                  const diffFmt = def.isInteger ? `${sign}${diff} ${def.unit}` : `${sign}${diff.toFixed(1)} ${def.unit}`;
                  const pctFmt = `${sign}${pct.toFixed(1)}%`;

                  return (
                    <tr key={def.key} className={isMod ? 'row-modified' : ''}>
                      <td><strong>{def.label}</strong></td>
                      <td>{baseVal} {def.unit}</td>
                      <td><span className="tag-provenance tag-ai">Image Analysis Estimate</span></td>
                      {hasModifications && (
                        <td className={isMod ? 'scen-value-cell' : ''}>
                          {scenVal} {def.unit}
                        </td>
                      )}
                      {hasModifications && (
                        <td className={isMod ? (diff > 0 ? 'delta-pos' : 'delta-neg') : ''}>
                          {isMod ? `${diffFmt} (${pctFmt})` : '—'}
                        </td>
                      )}
                      {hasModifications && (
                        <td>
                          <span className={`tag-provenance ${isMod ? 'tag-scenario' : 'tag-baseline'}`}>
                            {isMod ? 'What-If Scenario' : 'Unmodified Baseline'}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="empty-notice">No physical dimensions were identified or measured for this component.</p>
          )}
        </section>

        {/* Section 3: Engineering Validation */}
        <section className="report-section">
          <h3 className="section-title"><Icon>verified</Icon> 3. ENGINEERING GEOMETRY VALIDATION</h3>
          <div className={`report-validation-banner ${isGeometryValid ? 'val-pass' : 'val-fail'}`}>
            <div className="val-banner-header">
              <Icon>{isGeometryValid ? 'check_circle' : 'error'}</Icon>
              <strong>{isGeometryValid ? 'GEOMETRY CONSTRAINTS VALIDATED' : 'GEOMETRY CONSTRAINT VIOLATION'}</strong>
            </div>
            <ul className="val-checklist">
              {availableParams.length > 0 && (
                <li className={isGeometryValid ? 'pass' : 'fail'}>
                  <Icon>{isGeometryValid ? 'check' : 'close'}</Icon>
                  <span>Dimensional values must be strictly positive</span>
                </li>
              )}
              {hasOD && hasID && (
                <li className={isGeometryValid ? 'pass' : 'fail'}>
                  <Icon>{isGeometryValid ? 'check' : 'close'}</Icon>
                  <span>Bore interface clearance: Inner diameter &lt; Outer diameter</span>
                </li>
              )}
              {hasTeeth && (
                <li className={isGeometryValid ? 'pass' : 'fail'}>
                  <Icon>{isGeometryValid ? 'check' : 'close'}</Icon>
                  <span>Gear tooth count: Integer value (minimum 6 teeth)</span>
                </li>
              )}
            </ul>
            {!isGeometryValid && geometryError && (
              <div className="val-error-detail">
                <strong>Rejection Reason:</strong> {geometryError}
              </div>
            )}
          </div>
        </section>

        {/* Section 4: What-If Scenario State & Impact */}
        <section className="report-section">
          <h3 className="section-title"><Icon>tune</Icon> 4. WHAT-IF SCENARIO STATE & IMPACT</h3>
          {hasModifications ? (
            <div className="report-scenario-details">
              <div className="scenario-status-row">
                <span className="kv-label">SCENARIO IMPACT RATING:</span>
                <span className={`impact-badge impact-${impactStatus.toLowerCase().replace(/\s+/g, '-')}`}>
                  {impactStatus}
                </span>
              </div>
              <p className="scenario-status-desc">
                {impactStatus === 'INVALID'
                  ? 'Scenario exceeds valid geometric constraints.'
                  : impactStatus === 'STABLE'
                    ? 'Modifications are within baseline envelope (<5% deviation).'
                    : impactStatus === 'REVIEW'
                      ? 'Interface or moderate dimensional change (5–15%). Engineering review advised.'
                      : 'Significant dimensional deviation from baseline (>15%). Rigorous engineering verification required.'}
              </p>

              {materialVolumeImpact && (
                <div className="report-volume-box">
                  <div className="vol-box-title">APPROX. MATERIAL VOLUME ENVELOPE</div>
                  <div className="vol-box-row">
                    <div><span className="cad-label">BASELINE:</span> <strong>{materialVolumeImpact.baselineCm3} cm³</strong></div>
                    <Icon>arrow_forward</Icon>
                    <div><span className="cad-label">SCENARIO:</span> <strong>{materialVolumeImpact.scenarioCm3} cm³</strong></div>
                    <div><span className="cad-label">DELTA:</span> <strong className="scen-val">{materialVolumeImpact.deltaCm3} cm³ ({materialVolumeImpact.pct})</strong></div>
                  </div>
                  <small>Calculated using annular/cylindrical envelope approximation (V = π/4 × (OD² - ID²) × H).</small>
                </div>
              )}
            </div>
          ) : (
            <div className="report-no-scenario">
              <p>No active design scenario. The component is operating on its original baseline reconstruction.</p>
            </div>
          )}
        </section>

        {/* Section 5: Engineering Notes & Warnings */}
        <section className="report-section">
          <h3 className="section-title"><Icon>warning</Icon> 5. ENGINEERING NOTES & WARNINGS</h3>
          {warnings.length > 0 ? (
            <ul className="report-warnings-list">
              {warnings.map((w, idx) => (
                <li key={idx} className="report-warning-item">
                  <Icon>warning</Icon>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="report-clean-note">
              <Icon>check</Icon> No compatibility or interface warnings detected for the current parameters.
            </p>
          )}
        </section>

        {/* Section 6: Verification Notice */}
        <section className="report-section report-footer-notice">
          <div className="verification-notice-box">
            <Icon>info</Icon>
            <div>
              <strong>PHYSICAL VERIFICATION NOTICE</strong>
              <p>All measurements, material estimates, and 3D geometry recipes are synthesized from photographs and/or deterministic prototype scenarios. Dimensions and mating tolerances must be physically verified with calibrated measurement equipment prior to tooling, CNC machining, or production.</p>
            </div>
          </div>
        </section>
      </article>
    </div>
  );

  if (isWorkWindow) {
    return <div className="work-window report-work-window">{content}</div>;
  }

  return (
    <div className="report-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Engineering Decision Report">
      {content}
    </div>
  );
}

const DEFAULT_ANALYSIS = {
  componentType: 'spur_gear',
  componentName: '24T Industrial Spur Gear',
  label: 'Spur Gear (24T)',
  material: 'AISI 4140 Alloy Steel',
  confidence: 0.94,
  dimensions: {
    outerDiameter: 120,
    innerDiameter: 30,
    height: 28,
    thickness: 28,
    teeth: 24,
    module: 4.615,
  },
  features: [
    'Central Bore Ø30mm',
    '24 Involute Gear Teeth',
    'Keyway 8x4mm',
    'Shoulder Transition'
  ],
  geometryRecipe: {
    type: 'gear',
    gear: {
      type: 'spur',
      teeth: 24,
      module: 4.615,
      boreRadius: 15,
      faceWidth: 28,
      outerRadius: 60,
    }
  }
};

const LEFT_TABS = [
  { id: 'workbench', icon: 'view_in_ar', label: 'Workbench' },
  { id: 'mfg', icon: 'receipt_long', label: 'Manufacturing Intel' },
  { id: 'materials', icon: 'layers', label: 'Material Options' },
  { id: 'report', icon: 'description', label: 'Engineering Decision Report' },
  { id: 'drawing', icon: 'architecture', label: 'Engineering Drawing' },
  { id: 'whatif', icon: 'tune', label: 'Engineering What-If Simulator' },
  { id: 'export', icon: 'download', label: 'Export' },
];

function Workbench() {
  const {
    setPage,
    images,
    analysis,
    setAnalysis,
    stage,
    setStage,
    analysisVersion,
    machineryState,
    setMachineryState,
    viewMode,
    setViewMode,
    activeComponentId,
    setActiveComponentId,
    selectedComponentIds,
    setSelectedComponentIds,
    handleRegenerate,
    isRegenerating,
    isDirty,
    setLastAnalyzedSnapshot,
    reconstructionProgress,
    applyReconstructionProgress,
    cancelReconstruction,
    retryReconstruction,
    isReconstructionCancelled,
    ensureConditionAssessment,
    theme,
    toggleTheme,
  } = useApp();

  // Single source of truth for the active component specification. Every
  // downstream consumer (3D, drawings, exports, cost/reports and copilot)
  // derives from this analysis; scenario previews never replace it.
  const allComponents = useMemo(() => getAllComponents(machineryState), [machineryState]);
  const activeComp = useMemo(() => {
    return allComponents.find((c) => c.id === activeComponentId) || machineryState?.primaryGear;
  }, [allComponents, activeComponentId, machineryState]);
  const currentAnalysis = activeComp?.analysis || analysis;

  const [open, setOpen] = useState(true); // Engineering Copilot Chat OPEN by default!
  const [copilotTab, setCopilotTab] = useState('chat'); // 'chat' | 'components'
  const [activeTab, setActiveTab] = useState('workbench'); // Workbench tab open by default
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pipVisible, setPipVisible] = useState(false); // PiP disabled by default as requested
  const [scenarioParams, setScenarioParams] = useState({});
  const [deselectedRecommendations, setDeselectedRecommendations] = useState({});
  const [showReport, setShowReport] = useState(false);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(false);
  const [stress, setStress] = useState(false);
  const [dims, setDims] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const [showDrawing, setShowDrawing] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] = useState(null);
  const [hoveredFeatureId, setHoveredFeatureId] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [mfgData, setMfgData] = useState(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [illumination, setIllumination] = useState(false);
  const [illuminationIntensity, setIlluminationIntensity] = useState(DEFAULT_MODEL_ILLUMINATION_INTENSITY);
  const [modelBaseColor, setModelBaseColor] = useState(null);
  const [viewportBackgroundColor, setViewportBackgroundColor] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const historyRef = useRef([]);
  const thread = useRef(null);
  const meshBuildStartedRef = useRef(null);

  // ─── Persistent Modular Workspace State ─────────────────────────────
  const [layoutState, setLayoutState] = useState(() => ({
    ...loadWorkspaceLayout(),
    isManufacturingActive: false, // Ensure manufacture is NEVER enabled by default!
  }));

  const updateLayout = useCallback((updater) => {
    setLayoutState((prev) => {
      const partial = typeof updater === 'function' ? updater(prev) : updater;
      return { ...prev, ...partial };
    });
  }, []);

  // Persist layout safely to localStorage when state changes
  useEffect(() => {
    saveWorkspaceLayout(layoutState);
  }, [layoutState]);

  const handleResetLayout = useCallback(() => {
    const fresh = resetWorkspaceLayout();
    setLayoutState(fresh);
  }, []);

  const {
    leftPanelWidth,
    mfgPanelWidth,
    costPanelHeight,
    isLeftPanelOpen,
    isManufacturingActive,
    isCostPanelCollapsed,
    isLeftPanelDocked,
    isMfgPanelDocked,
    isCostPanelDocked,
    isLeftPanelMaximized,
    isMfgPanelMaximized,
    isCostPanelMaximized,
    isWorkspaceMaximized,
    leftPanelFloatingPos,
    mfgPanelFloatingPos,
    costPanelFloatingPos,
    ribbonExpanded,
    contextualPanelSlot = 'left',
    workspaceSlot = 'center',
    mfgPanelSlot = 'right',
    costPanelSlot = 'bottom',
    isWorkspaceClosed = false,
  } = layoutState;

  const ready = (stage === 'ready' || stage === 'idle' || !stage) && Boolean(currentAnalysis);
  const isMfgActive = Boolean(ready && isManufacturingActive);

  // Drag and Drop Panel Repositioning State
  const [draggedPanel, setDraggedPanel] = useState(null); // 'contextual' | 'manufacturing' | 'cost' | 'workspace' | null
  const [hoveredDockZone, setHoveredDockZone] = useState(null); // 'left' | 'right' | 'bottom' | 'center' | null
  const [dragMousePos, setDragMousePos] = useState(null);
  const [isResizingDivider, setIsResizingDivider] = useState(false);

  // Responsive Window Constraints
  useEffect(() => {
    const handleWindowResize = () => {
      updateLayout((prev) => enforceResponsiveBounds(prev, window.innerWidth, window.innerHeight));
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [updateLayout]);

  // 1-Click Slot Switcher
  const handleMoveSlot = useCallback((panelKey, targetSlot) => {
    updateLayout((s) => repositionPanelSlot(s, panelKey, targetSlot));
  }, [updateLayout]);

  // Drag-and-drop repositioning initiator
  const handleStartDragPanel = useCallback((panelKey, e) => {
    e.preventDefault();
    setDraggedPanel(panelKey);
    setDragMousePos({ x: e.clientX, y: e.clientY });

    const onMouseMove = (moveEv) => {
      const x = moveEv.clientX;
      const y = moveEv.clientY;
      setDragMousePos({ x, y });

      const w = window.innerWidth;
      const h = window.innerHeight;

      if (x < w * 0.28) {
        setHoveredDockZone('left');
      } else if (x > w * 0.72) {
        setHoveredDockZone('right');
      } else if (y > h * 0.65) {
        setHoveredDockZone('bottom');
      } else {
        setHoveredDockZone('center');
      }
    };

    const onMouseUp = (upEv) => {
      const x = upEv.clientX;
      const y = upEv.clientY;
      const w = window.innerWidth;
      const h = window.innerHeight;

      let finalZone = 'center';
      if (x < w * 0.28) {
        finalZone = 'left';
      } else if (x > w * 0.72) {
        finalZone = 'right';
      } else if (y > h * 0.65) {
        finalZone = 'bottom';
      }

      updateLayout((s) => {
        return repositionPanelSlot(s, panelKey, finalZone);
      });

      setDraggedPanel(null);
      setHoveredDockZone(null);
      setDragMousePos(null);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [updateLayout]);

  // Contextual tool selected in ribbon: 'components' by default (or 'inspection', 'health', or null if closed)
  const [selectedContextTool, setSelectedContextTool] = useState('components');
  // Active tab in left panel: 'components' by default alongside Copilot
  const [activeLeftTab, setActiveLeftTab] = useState('components');

  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
  const [reportNoticeOpen, setReportNoticeOpen] = useState(false);

  const handleToggleRibbonContextTool = useCallback((tool) => {
    setSelectedContextTool(prev => {
      if (prev === tool) {
        // Close it! Only Copilot remains
        setActiveLeftTab('chat');
        return null;
      } else {
        // Activate it and restore default width
        setActiveLeftTab(tool);
        updateLayout({
          isLeftPanelOpen: true,
          leftPanelWidth: DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth,
          isLeftPanelMaximized: false,
        });
        return tool;
      }
    });
  }, [updateLayout]);

  const handleToggleRibbonCopilot = useCallback(() => {
    updateLayout((s) => {
      if (!s.isLeftPanelOpen) {
        setActiveLeftTab('chat');
        return {
          isLeftPanelOpen: true,
          leftPanelWidth: DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth,
          isLeftPanelMaximized: false,
        };
      } else if (activeLeftTab === 'chat') {
        if (selectedContextTool) {
          setActiveLeftTab(selectedContextTool);
          return {};
        } else {
          return { isLeftPanelOpen: false };
        }
      } else {
        setActiveLeftTab('chat');
        return {
          isLeftPanelOpen: true,
          leftPanelWidth: DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth,
          isLeftPanelMaximized: false,
        };
      }
    });
  }, [activeLeftTab, selectedContextTool, updateLayout]);

  // Manufacturing Decisions State (with persistence)
  const [decisions, setDecisions] = useState(() => {
    const saved = localStorage.getItem('reforge_mfg_decisions');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // fallback
      }
    }
    return {
      material: { id: 'aisi-4140', label: 'AISI 4140 Alloy Steel (Chromoly)', yieldMPa: 655, hardness: '28–32 HRC (Pre-hardened)' },
      process: { id: 'hobbing-cnc', label: 'CNC Gear Hobbing + Milling', leadTime: '8–12 days', accuracy: 'DIN 7' },
      surfaceTreatment: { id: 'black-oxide', label: 'Black Oxide (MIL-DTL-13924)' },
      tolerances: { id: 'iso-grade-7', label: 'DIN 7 / ISO Grade 7 (Standard Precision)' },
      heatTreatment: { id: 'case-carburizing', label: 'Case Carburized (58–62 HRC, 0.8–1.2mm depth)' },
      inspection: { id: 'cmm-lead-profile', label: 'CMM Tooth Profile & Involute Lead Inspection' },
      packaging: { id: 'vci-sealed', label: 'VCI Vapor-Inhibitor Sealed Bag + Foam Cradles' },
    };
  });

  // Manufacturing Confirmed Categories State (synced across panels)
  const [confirmedCategories, setConfirmedCategories] = useState(() => {
    const loaded = loadManufacturingState();
    return loaded.confirmedCategories || {};
  });

  // Active Draft selection being previewed in configurator before confirmation
  const [activeDraftSelection, setActiveDraftSelection] = useState(null);

  const updateDecision = useCallback((key, value) => {
    setDecisions(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('reforge_mfg_decisions', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleToggleRibbon = useCallback(() => {
    updateLayout((s) => ({ ribbonExpanded: !s.ribbonExpanded }));
  }, [updateLayout]);

  const handleToggleLeftPanel = useCallback((val) => {
    updateLayout((s) => {
      const willBeOpen = val !== undefined ? val : !s.isLeftPanelOpen;
      return {
        isLeftPanelOpen: willBeOpen,
        // When reopening / enabling, restore the default width
        ...(willBeOpen ? { leftPanelWidth: DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth, isLeftPanelMaximized: false } : {}),
      };
    });
  }, [updateLayout]);

  const handleResizeLeftPanel = useCallback((w) => {
    updateLayout({ leftPanelWidth: w });
  }, [updateLayout]);

  const handleResizeMfgPanel = useCallback((w) => {
    updateLayout({ mfgPanelWidth: w });
  }, [updateLayout]);

  const handleResizeCostPanel = useCallback((h) => {
    updateLayout({ costPanelHeight: h });
  }, [updateLayout]);

  const handleMouseDownLeftResizer = useCallback((e) => {
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setIsResizingDivider(true);

    const onMouseMove = (moveEv) => {
      const maxAvailable = Math.max(380, window.innerWidth - (isMfgActive ? mfgPanelWidth : 0) - 320);
      const nextW = Math.max(LAYOUT_BOUNDS.leftPanelWidth.min, Math.min(Math.min(LAYOUT_BOUNDS.leftPanelWidth.max, maxAvailable), moveEv.clientX));
      updateLayout({ leftPanelWidth: nextW });
    };

    const onMouseUp = () => {
      setIsResizingDivider(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [isMfgActive, mfgPanelWidth, updateLayout]);

  const handleMouseDownRightResizer = useCallback((e) => {
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setIsResizingDivider(true);

    const onMouseMove = (moveEv) => {
      const maxAvailable = Math.max(380, window.innerWidth - (isLeftPanelOpen ? leftPanelWidth : 0) - 320);
      const nextW = Math.max(LAYOUT_BOUNDS.mfgPanelWidth.min, Math.min(Math.min(LAYOUT_BOUNDS.mfgPanelWidth.max, maxAvailable), window.innerWidth - moveEv.clientX));
      updateLayout({ mfgPanelWidth: nextW });
    };

    const onMouseUp = () => {
      setIsResizingDivider(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [isLeftPanelOpen, leftPanelWidth, updateLayout]);

  const handleMouseDownCostResizer = useCallback((e) => {
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    setIsResizingDivider(true);

    const startY = e.clientY;
    const startHeight = layoutState.costPanelHeight;

    const onMouseMove = (moveEv) => {
      const deltaY = startY - moveEv.clientY;
      const maxH = Math.round(window.innerHeight * 0.55);
      const nextH = Math.max(160, Math.min(maxH, startHeight + deltaY));
      updateLayout({ costPanelHeight: nextH });
    };

    const onMouseUp = () => {
      setIsResizingDivider(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [layoutState.costPanelHeight, updateLayout]);

  const decisionDependencies = useMemo(() => {
    const deps = [];
    if (decisions.material?.id === 'al-7075-t6' || decisions.material?.id === 'ss-316l') {
      if (decisions.heatTreatment?.id === 'case-carburizing') {
        deps.push({
          target: 'heatTreatment',
          title: 'Material / Heat Treatment Conflict',
          reason: `${decisions.material.label} cannot be carburized. Solution heat treating, anodizing, or precipitation hardening required.`,
        });
      }
    }
    if (decisions.tolerances?.id === 'iso-grade-6') {
      if (decisions.process?.id === 'hobbing-cnc') {
        deps.push({
          target: 'process',
          title: 'Tolerance / Process Compatibility',
          reason: 'DIN 6 / ISO Grade 6 requires tooth grinding or wire EDM finishing passes beyond conventional hobbing.',
        });
      }
    }
    return deps;
  }, [decisions]);

  const isManufacturingComplete = useMemo(() => {
    const { confirmedCategories } = loadManufacturingState();
    const deps = evaluateTechnicalDependencies(decisions, quantity, confirmedCategories);
    const { isAllConfirmed } = computeConfiguratorStatuses(decisions, confirmedCategories, null, deps);
    return Boolean(isAllConfirmed);
  }, [decisions, quantity]);

  useEffect(() => {
    if (thread.current) {
      thread.current.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, thinking]);

  useEffect(() => {
    if (!currentAnalysis || stage !== 'extracting' || isReconstructionCancelled()) return;
    if (meshBuildStartedRef.current === currentAnalysis) return;
    meshBuildStartedRef.current = currentAnalysis;
    applyReconstructionProgress({
      stage: 'mesh-generation',
      status: 'running',
      completed: 0,
      total: 1,
      message: 'Building parametric mesh…',
    });
    setStage('reconstructing');
  }, [stage, currentAnalysis, setStage, applyReconstructionProgress, isReconstructionCancelled]);

  useEffect(() => {
    if (!currentAnalysis || stage !== 'reconstructing' || isReconstructionCancelled()) return;

    try {
      const analysedComponents = getAllComponents(machineryState).filter((component) => component.analysis);
      const targets = analysedComponents.length ? analysedComponents : [{ id: 'primary', analysis: currentAnalysis }];
      const generated = targets.map((component, index) => {
        const model = buildModel(component.analysis);
        applyReconstructionProgress({
          stage: 'mesh-generation',
          status: 'running',
          completed: index + 1,
          total: targets.length,
          message: `Generated mesh ${index + 1} of ${targets.length}.`,
        });
        return model;
      });
      if (isReconstructionCancelled()) return;

      applyReconstructionProgress({ stage: 'mesh-generation', status: 'complete' });
      applyReconstructionProgress({
        stage: 'validation',
        status: 'running',
        message: 'Checking mesh geometry and model bounds…',
      });

      const validations = generated.map((model) => validateReconstructedModel(model));
      if (!validations.length || !validations.every((result) => result.valid)) {
        throw new Error('Reconstructed model failed geometry validation.');
      }
      if (isReconstructionCancelled()) return;

      applyReconstructionProgress({
        stage: 'validation',
        status: 'complete',
        message: 'Model generated and validated.',
      });
      setStage('ready');
    } catch (error) {
      applyReconstructionProgress({
        type: 'failed',
        stage: 'validation',
        message: error.message || 'Model generation failed.',
      });
      setStage('idle');
    }
  }, [stage, currentAnalysis, machineryState, setStage, applyReconstructionProgress, isReconstructionCancelled]);

  const features = useMemo(() => normalizeFeatures(currentAnalysis), [currentAnalysis]);

  // Ensure manufacturing data is loaded for copilot, drawings, and reports
  useEffect(() => {
    if (!currentAnalysis) return;
    // The manufacturing engine only consumes geometry fields; sending the full
    // analysis serialises condition masks that the backend immediately drops.
    const geometryAnalysis = {
      componentType: currentAnalysis.componentType,
      dimensions: currentAnalysis.dimensions,
      features: currentAnalysis.features,
      materialEstimate: currentAnalysis.materialEstimate,
      geometryRecipe: currentAnalysis.geometryRecipe,
    };
    fetchManufacturingIntelligence(geometryAnalysis, quantity)
      .then(res => setMfgData(res))
      .catch(() => { });
  }, [currentAnalysis, quantity]);

  // Load sample gear helper
  const loadSampleGear = useCallback(() => {
    const initial = createInitialMachineryState();
    initial.primaryGear.analysis = DEFAULT_ANALYSIS;
    setMachineryState(initial);
    setLastAnalyzedSnapshot(createMachinerySnapshot(initial));
    setAnalysis(DEFAULT_ANALYSIS);
    setStage('ready');
  }, [setMachineryState, setLastAnalyzedSnapshot, setAnalysis, setStage]);

  // Load condition evidence only when an explicit consumer asks for it.
  useEffect(() => {
    const wantsCondition = selectedContextTool === 'health' || stress;
    if (!ready || !wantsCondition) return;
    const targetAnalysis = currentAnalysis;
    if (!targetAnalysis || targetAnalysis.conditionAssessment) return;
    const targetImages = activeComp?.images?.length ? activeComp.images : images;
    if (!targetImages?.length) return;
    ensureConditionAssessment(targetAnalysis, targetImages);
  }, [
    ready,
    selectedContextTool,
    stress,
    currentAnalysis,
    activeComp?.images,
    images,
    ensureConditionAssessment,
  ]);

  // Sync analysis whenever activeComponentId changes or when the active component gets an analysis
  useEffect(() => {
    if (activeComp?.analysis && activeComp.analysis !== analysis) {
      setAnalysis(activeComp.analysis);
    }
  }, [activeComp?.id, activeComp?.analysis]);

  const activeScope = viewMode === 'assembly' ? 'assembly' : machineryState?.companionGear ? 'pair' : 'single';

  // Build structured Engineering Context for Copilot
  const engineeringContext = useMemo(() => {
    if (!ready) return null;
    return buildEngineeringContext({
      analysis: currentAnalysis,
      manufacturingIntelligence: mfgData,
      quantity,
      features,
      materialAlternatives: null,
      machineryState,
      activeScope,
    });
  }, [ready, currentAnalysis, mfgData, quantity, features, machineryState, activeScope]);

  // Generate context-aware suggestions
  const suggestions = useMemo(() => {
    return getEngineeringSuggestions(engineeringContext);
  }, [engineeringContext]);

  // Reset scenario when a new analysis is loaded
  useEffect(() => {
    setScenarioParams({});
    setDeselectedRecommendations({});
  }, [currentAnalysis]);

  const send = async (e, customMsg = null) => {
    if (e) e.preventDefault();
    const msgToSend = typeof customMsg === 'string' ? customMsg.trim() : text.trim();
    if (!msgToSend || thinking) return;
    setMessages(m => [...m, { role: 'user', text: msgToSend }]);
    if (!customMsg) setText('');
    setThinking(true);
    try {
      const reply = await sendChatMessage(msgToSend, engineeringContext || currentAnalysis, historyRef.current);
      setMessages(m => [...m, { role: 'ai', text: reply }]);
      historyRef.current = [...historyRef.current, { role: 'user', text: msgToSend }, { role: 'model', text: reply }];
    } catch (err) {
      setMessages(m => [...m, { role: 'ai', text: `[ENGINEER OFFLINE] ${err.message}`, error: true }]);
    }
    setThinking(false);
  };

  // Reset comparison & features when a new component analysis is loaded (preserve chat history on regeneration)
  useEffect(() => {
    setMfgData(null);
    setSelectedFeatureId(null);
    setHoveredFeatureId(null);
  }, [analysisVersion]);

  const label = currentAnalysis ? resolveLabel(currentAnalysis) : null;
  const conf = currentAnalysis && typeof currentAnalysis.confidence === 'number' ? Math.round(currentAnalysis.confidence * 100) : null;
  const geometrySourceLabel = currentAnalysis?.geometrySource
    ? (GEOMETRY_SOURCE_LABELS[currentAnalysis.geometrySource] || String(currentAnalysis.geometrySource).toUpperCase())
    : null;
  const stageIndex = currentAnalysis ? (stage === 'extracting' ? 2 : stage === 'reconstructing' ? 3 : 5) : 0;

  // Scenario recommendations are derived from direct edits only. They stay as
  // suggestions until the user confirms; deselected ones are opt-out.
  const recommendations = useMemo(
    () => getParameterRecommendations(currentAnalysis, scenarioParams),
    [currentAnalysis, scenarioParams]
  );
  const selectedRecommendationParams = useMemo(() => Object.fromEntries(
    recommendations
      .filter(rec => !deselectedRecommendations[rec.key])
      .map(rec => [rec.key, rec.value])
  ), [recommendations, deselectedRecommendations]);
  const effectiveScenarioParams = useMemo(
    () => ({ ...selectedRecommendationParams, ...scenarioParams }),
    [selectedRecommendationParams, scenarioParams]
  );

  // Geometry Validation
  const { isGeometryValid, geometryError } = useMemo(() => {
    if (!currentAnalysis) return { isGeometryValid: true, geometryError: null };
    const currentOD = effectiveScenarioParams.outerDiameter ?? getParameterValue(currentAnalysis, 'outerDiameter');
    const currentID = effectiveScenarioParams.innerDiameter ?? getParameterValue(currentAnalysis, 'innerDiameter');
    const currentTeeth = effectiveScenarioParams.teeth ?? getParameterValue(currentAnalysis, 'teeth');

    for (const [k, v] of Object.entries(effectiveScenarioParams)) {
      if (k !== 'innerDiameter' && k !== 'helixAngle' && typeof v === 'number' && v <= 0) {
        return { isGeometryValid: false, geometryError: 'Dimensions must be strictly positive.' };
      }
    }

    if (typeof currentOD === 'number' && typeof currentID === 'number' && currentOD > 0) {
      if (currentID >= currentOD) {
        return {
          isGeometryValid: false,
          geometryError: 'Inner diameter must be smaller than outer diameter.',
        };
      }
    }

    if (typeof currentTeeth === 'number') {
      if (currentTeeth < 6 || !Number.isInteger(currentTeeth)) {
        return {
          isGeometryValid: false,
          geometryError: 'Tooth count must be an integer of at least 6 teeth.',
        };
      }
    }

    return { isGeometryValid: true, geometryError: null };
  }, [currentAnalysis, effectiveScenarioParams]);

  // Approximate material volume impact
  const materialVolumeImpact = useMemo(() => {
    if (!currentAnalysis) return null;
    const od0 = getParameterValue(currentAnalysis, 'outerDiameter');
    const id0 = getParameterValue(currentAnalysis, 'innerDiameter') || 0;
    const h0 = getParameterValue(currentAnalysis, 'height');
    if (typeof od0 !== 'number' || typeof h0 !== 'number' || od0 <= 0 || h0 <= 0) {
      return null;
    }

    const odS = effectiveScenarioParams.outerDiameter ?? od0;
    const idS = effectiveScenarioParams.innerDiameter ?? id0;
    const hS = effectiveScenarioParams.height ?? (effectiveScenarioParams.thickness ?? h0);

    if (odS <= 0 || hS <= 0 || idS >= odS) return null;

    const v0 = (Math.PI / 4) * (od0 * od0 - id0 * id0) * h0;
    const vS = (Math.PI / 4) * (odS * odS - idS * idS) * hS;
    const deltaV = vS - v0;
    const pctV = v0 > 0 ? (deltaV / v0) * 100 : 0;

    const v0Cm3 = (v0 / 1000).toFixed(1);
    const vSCm3 = (vS / 1000).toFixed(1);
    const deltaVCm3 = ((vS - v0) / 1000).toFixed(1);
    const sign = deltaV >= 0 ? '+' : '';

    return {
      baselineCm3: v0Cm3,
      scenarioCm3: vSCm3,
      deltaCm3: `${sign}${deltaVCm3}`,
      pct: `${sign}${pctV.toFixed(1)}%`,
    };
  }, [currentAnalysis, effectiveScenarioParams]);

  // Deterministic warnings and impact status
  const { warnings, impactStatus } = useMemo(() => {
    if (!currentAnalysis) return { warnings: [], impactStatus: 'STABLE' };
    if (!isGeometryValid) {
      return {
        warnings: [geometryError || 'Invalid geometric configuration.'],
        impactStatus: 'INVALID',
      };
    }

    const warnList = [];
    let maxPct = 0;
    let hasCriticalChange = false;

    for (const def of PARAM_DEFINITIONS) {
      if (!isParamActive(def, currentAnalysis)) continue;
      const baseVal = getParameterValue(currentAnalysis, def.key);
      if (typeof baseVal !== 'number' || !isFinite(baseVal)) continue;

      const scenVal = effectiveScenarioParams[def.key] ?? baseVal;
      const absDiff = Math.abs(scenVal - baseVal);
      if (absDiff > 0.0001) {
        const pct = baseVal !== 0 ? Math.abs((scenVal - baseVal) / baseVal) * 100 : 0;
        if (pct > maxPct) maxPct = pct;

        if (def.key === 'innerDiameter') {
          hasCriticalChange = true;
          warnList.push('Bore interface changed — mating compatibility should be checked.');
        } else if (def.key === 'outerDiameter') {
          hasCriticalChange = true;
          warnList.push('Outer interface changed — mating compatibility should be checked.');
        } else if (def.key === 'teeth') {
          hasCriticalChange = true;
          warnList.push('Tooth count changed — mating gear compatibility should be checked.');
        } else if (def.key === 'height' || def.key === 'thickness' || def.key === 'length') {
          warnList.push('Axial dimension changed — fit and clearance should be verified.');
        } else if (def.key === 'module') {
          hasCriticalChange = true;
          warnList.push('Gear module changed — pitch circle and mating gear mesh will be affected.');
        } else if (def.key === 'helixAngle') {
          hasCriticalChange = true;
          warnList.push('Helix angle changed — thrust load and mating gear angle must be matched.');
        }

        if (pct > 15) {
          warnList.push(`Significant dimensional deviation in ${def.label} (${pct.toFixed(0)}%) — engineering verification recommended.`);
        }
      }
    }

    let status = 'STABLE';
    if (Object.keys(effectiveScenarioParams).length > 0) {
      if (maxPct > 15) {
        status = 'HIGH IMPACT';
      } else if (maxPct >= 5 || hasCriticalChange) {
        status = 'REVIEW';
      } else {
        status = 'STABLE';
      }
    }

    return { warnings: [...new Set(warnList)], impactStatus: status };
  }, [currentAnalysis, effectiveScenarioParams, isGeometryValid, geometryError]);

  // Only confirmed changes are written to the analysis that drives the 3D model.
  const activeReconstructionAnalysis = currentAnalysis;
  const gearTypeNeedsConfirmation = Boolean(currentAnalysis)
    && isGearTypeUnconfirmed(currentAnalysis)
    && Boolean(
      currentAnalysis.requiresGearTypeConfirmation ||
      currentAnalysis.teeth ||
      currentAnalysis.geometryRecipe?.gear ||
      /gear|tooth|teeth|worm|rack/i.test(String(currentAnalysis.componentType || ''))
    );
  const modifiedCount = Object.keys(effectiveScenarioParams).length;

  const handleToggleRecommendation = useCallback((key) => {
    setDeselectedRecommendations(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleResetRecommendations = useCallback(() => {
    setDeselectedRecommendations({});
  }, []);

  // A confirmed gear type replaces the active analysis so 3D, drawings,
  // CAD, FEA, health, manufacturing and cost all consume the same classification.
  const handleConfirmGearType = useCallback((rawGearType) => {
    const confirmedAnalysis = applyConfirmedGearType(currentAnalysis, rawGearType);
    if (!confirmedAnalysis) return;

    const targetId = activeComp?.id || machineryState?.primaryGear?.id;
    const replaceAnalysis = (component) => (
      component && (component.id === targetId || (!targetId && component === machineryState?.primaryGear))
        ? { ...component, analysis: confirmedAnalysis }
        : component
    );
    const nextMachineryState = {
      ...machineryState,
      primaryGear: replaceAnalysis(machineryState?.primaryGear),
      companionGear: replaceAnalysis(machineryState?.companionGear),
      additionalComponents: (machineryState?.additionalComponents || []).map(replaceAnalysis),
    };

    const nextDecisions = { ...decisions, ...getGeometryDecisionOverrides(confirmedAnalysis) };
    setAnalysis(confirmedAnalysis);
    setMachineryState(nextMachineryState);
    setLastAnalyzedSnapshot(createMachinerySnapshot(nextMachineryState));
    setDecisions(nextDecisions);
    saveManufacturingState(nextDecisions, confirmedCategories);
    setMfgData(null);
    setActiveDraftSelection(null);
    setDeselectedRecommendations({});
  }, [
    activeComp?.id,
    confirmedCategories,
    currentAnalysis,
    decisions,
    machineryState,
  ]);

  const handleConfirmScenario = useCallback(() => {
    if (!currentAnalysis || !isGeometryValid || Object.keys(effectiveScenarioParams).length === 0) return;

    const confirmedAnalysis = applyScenarioToAnalysis(currentAnalysis, effectiveScenarioParams);
    const targetId = activeComp?.id || machineryState?.primaryGear?.id;
    const replaceAnalysis = component => (
      component && (component.id === targetId || (!targetId && component === machineryState?.primaryGear))
        ? { ...component, analysis: confirmedAnalysis }
        : component
    );
    const nextMachineryState = {
      ...machineryState,
      primaryGear: replaceAnalysis(machineryState?.primaryGear),
      companionGear: replaceAnalysis(machineryState?.companionGear),
      additionalComponents: (machineryState?.additionalComponents || []).map(replaceAnalysis),
    };

    // Cost and report panels consume manufacturing decisions. Re-derive their
    // geometry from the same confirmed analysis so no panel keeps stale values.
    const nextDecisions = { ...decisions, ...getGeometryDecisionOverrides(confirmedAnalysis) };

    setAnalysis(confirmedAnalysis);
    setMachineryState(nextMachineryState);
    setLastAnalyzedSnapshot(createMachinerySnapshot(nextMachineryState));
    setDecisions(nextDecisions);
    saveManufacturingState(nextDecisions, confirmedCategories);
    setMfgData(null);
    setActiveDraftSelection(null);
    setScenarioParams({});
    setDeselectedRecommendations({});
    setActiveTab('workbench');
  }, [
    activeComp?.id,
    confirmedCategories,
    currentAnalysis,
    decisions,
    effectiveScenarioParams,
    isGeometryValid,
    machineryState,
    setAnalysis,
    setMachineryState,
    setLastAnalyzedSnapshot,
  ]);

  return (
    <>
      <main className="persistent-workspace-layout">
        {/* Top Expandable/Collapsible Icon Ribbon */}
        <TopRibbon
          expanded={ribbonExpanded}
          onToggleExpanded={handleToggleRibbon}
          onNavigateHome={() => setPage('home')}
          onNavigateUpload={() => setPage('upload')}
          isCopilotActive={isLeftPanelOpen && activeLeftTab === 'chat'}
          selectedContextTool={selectedContextTool}
          onToggleCopilot={handleToggleRibbonCopilot}
          onToggleContextTool={handleToggleRibbonContextTool}
          autoRotate={autoRotate}
          onToggleAutoRotate={() => setAutoRotate(v => !v)}
          wire={wire}
          onToggleWire={() => setWire(w => !w)}
          stress={stress}
          onToggleStress={() => setStress(s => !s)}
          grid={grid}
          onToggleGrid={() => setGrid(g => !g)}
          dims={dims}
          onToggleDims={() => setDims(d => !d)}
          illumination={illumination}
          onToggleIllumination={() => setIllumination(on => !on)}
          illuminationIntensity={illuminationIntensity}
          onChangeIlluminationIntensity={setIlluminationIntensity}
          modelBaseColor={modelBaseColor}
          onChangeModelBaseColor={setModelBaseColor}
          viewportBackgroundColor={viewportBackgroundColor}
          onChangeViewportBackgroundColor={setViewportBackgroundColor}
          onResetView={() => setResetKey(k => k + 1)}
          viewMode={viewMode}
          onChangeViewMode={setViewMode}
          availableGearsCount={allComponents.length}
          pipVisible={pipVisible}
          onTogglePip={() => setPipVisible(v => !v)}
          isWorkspaceMaximized={isWorkspaceMaximized}
          onToggleMaximizeWorkspace={() => updateLayout((s) => ({ isWorkspaceMaximized: !s.isWorkspaceMaximized }))}
          onResetLayout={handleResetLayout}
          onOpenWhatIf={() => setActiveTab(activeTab === 'whatif' ? 'workbench' : 'whatif')}
          isWhatIfActive={activeTab === 'whatif'}
          onOpen2DDrawing={() => setShowDrawing(true)}
          onOpenExport={() => setActiveTab(activeTab === 'export' ? 'workbench' : 'export')}
          isExportActive={activeTab === 'export'}
          isManufacturingActive={isMfgActive}
          onToggleManufacture={() => {
            if (!ready) return;
            updateLayout((s) => {
              const willBeActive = !s.isManufacturingActive;
              const target2FifthWidth = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.40) : 576;
              return {
                isManufacturingActive: willBeActive,
                mfgPanelWidth: willBeActive && (!s.mfgPanelWidth || s.mfgPanelWidth === 440 || s.mfgPanelWidth < target2FifthWidth * 0.85)
                  ? target2FifthWidth
                  : s.mfgPanelWidth,
              };
            });
          }}
          onOpenReport={() => setIsReportDialogOpen(true)}
          isManufacturingComplete={isManufacturingComplete}
          onShowReportNotice={() => setReportNoticeOpen(true)}
          theme={theme}
          onToggleTheme={toggleTheme}
          ready={ready}
          label={label}
        />

        {/* Panel Render Helpers with slot-based docking */}
        {(() => {
          const renderContextualPanel = (slot) => (
            <LeftContextualPanel
              isOpen={isLeftPanelOpen}
              onToggleOpen={handleToggleLeftPanel}
              width={slot === 'left' ? leftPanelWidth : slot === 'right' ? mfgPanelWidth : undefined}
              onResize={slot === 'left' ? handleResizeLeftPanel : handleResizeMfgPanel}
              isDocked={true}
              isMaximized={isLeftPanelMaximized}
              onToggleMaximize={() => updateLayout((s) => ({ isLeftPanelMaximized: !s.isLeftPanelMaximized }))}
              onStartDrag={(e) => handleStartDragPanel('contextual', e)}
              onClose={() => handleToggleLeftPanel(false)}
              currentSlot={slot}
              activeTab={activeLeftTab}
              onSelectTab={setActiveLeftTab}
              selectedContextTool={selectedContextTool}
              messages={messages}
              text={text}
              setText={setText}
              thinking={thinking}
              onSendMessage={send}
              suggestions={suggestions}
              ready={ready}
              label={label}
              conf={conf}
              activeScope={activeScope}
              quantity={quantity}
              engineeringContext={engineeringContext}
              mfgData={mfgData}
              isDirty={isDirty}
              isRegenerating={isRegenerating}
              onRegenerate={handleRegenerate}
              analysis={activeReconstructionAnalysis}
              features={features}
              selectedFeatureId={selectedFeatureId}
              hoveredFeatureId={hoveredFeatureId}
              onSelectFeature={setSelectedFeatureId}
              onHoverFeature={setHoveredFeatureId}
              dims={dims}
              onToggleDims={() => setDims(d => !d)}
              machineryState={machineryState}
              setMachineryState={setMachineryState}
              activeComponentId={activeComponentId}
              setActiveComponentId={setActiveComponentId}
            />
          );

          const renderManufacturingPanel = (slot) => (
            <ManufacturingDecisionPanel
              isOpen={isMfgActive}
              onClose={() => updateLayout({ isManufacturingActive: false })}
              width={slot === 'right' ? mfgPanelWidth : slot === 'left' ? leftPanelWidth : undefined}
              onResize={slot === 'right' ? handleResizeMfgPanel : handleResizeLeftPanel}
              isDocked={true}
              isMaximized={isMfgPanelMaximized}
              onToggleMaximize={() => updateLayout((s) => ({ isMfgPanelMaximized: !s.isMfgPanelMaximized }))}
              onStartDrag={(e) => handleStartDragPanel('manufacturing', e)}
              currentSlot={slot}
              analysis={activeReconstructionAnalysis}
              decisions={decisions}
              onChangeDecision={updateDecision}
              dependencies={decisionDependencies}
              quantity={quantity}
              onChangeQuantity={setQuantity}
              onOpenReport={() => setIsReportDialogOpen(true)}
              confirmedCategories={confirmedCategories}
              onConfirmedCategoriesChange={setConfirmedCategories}
              onDraftSelect={setActiveDraftSelection}
            />
          );

          const renderCostPanel = (slot) => (
            <CostEstimationPanel
              isOpen={isMfgActive}
              onClose={() => updateLayout({ isCostPanelCollapsed: true })}
              height={slot === 'bottom' ? costPanelHeight : undefined}
              onResize={handleResizeCostPanel}
              isDocked={true}
              isMaximized={isCostPanelMaximized}
              onToggleMaximize={() => updateLayout((s) => ({ isCostPanelMaximized: !s.isCostPanelMaximized }))}
              onStartDrag={(e) => handleStartDragPanel('cost', e)}
              isCollapsed={isCostPanelCollapsed}
              onToggleCollapse={() => updateLayout((s) => ({ isCostPanelCollapsed: !s.isCostPanelCollapsed }))}
              currentSlot={slot}
              mfgData={mfgData}
              quantity={quantity}
              decisions={decisions}
              confirmedCategories={confirmedCategories}
              activeDraftSelection={activeDraftSelection}
              dependenciesCount={decisionDependencies.length}
              analysis={activeReconstructionAnalysis}
            />
          );

          const renderWorkspacePanel = (slot) => (
            <div className={`workspace-viewport-window ${isWorkspaceMaximized ? 'workspace-maximized-full' : ''} in-slot-${slot}`}>
              <section className="viewport">
                {/* 3D Workspace Top Header with 3 Window Controls */}
                <div className="workspace-window-header">
                  <div className="workspace-window-title-group">
                    <Icon className="workspace-hdr-icon">view_in_ar</Icon>
                    <span className="workspace-window-title">3D WORKSPACE</span>
                    {ready && <span className="workspace-window-badge">● {label}</span>}
                  </div>

                  <div className="panel-header-actions">
                    <button
                      type="button"
                      className="panel-action-btn panel-drag-handle"
                      onMouseDown={(e) => handleStartDragPanel('workspace', e)}
                      title="Dock button: Drag and drop 3D Workspace into any panel area (Left, Center, Right, Bottom)"
                      aria-label="Dock and drag 3D Workspace"
                    >
                      <Icon>drag_indicator</Icon>
                    </button>
                    <button
                      type="button"
                      className="panel-action-btn"
                      onClick={() => updateLayout((s) => ({ isWorkspaceMaximized: !s.isWorkspaceMaximized, isWorkspaceClosed: false }))}
                      title={isWorkspaceMaximized ? "Restore workspace size" : "Maximize workspace"}
                      aria-label={isWorkspaceMaximized ? "Restore Workspace" : "Maximize Workspace"}
                    >
                      <Icon>{isWorkspaceMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
                    </button>
                    <button
                      type="button"
                      className="panel-action-btn close-btn"
                      onClick={() => updateLayout({ isWorkspaceClosed: true })}
                      title="Close 3D Workspace"
                      aria-label="Close 3D Workspace"
                    >
                      <Icon>close</Icon>
                    </button>
                  </div>
                </div>

                <div className="cad viewport-status" aria-live="polite">
                  {ready
                    ? <>● {label}{conf != null ? ` · CONFIDENCE ${conf}%` : ''}{geometrySourceLabel ? ` · ${geometrySourceLabel}` : ''}<br /><span>AI RECONSTRUCTED FROM {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED{modifiedCount > 0 ? ' · WHAT-IF SCENARIO ACTIVE' : ''}</span></>
                    : <>● {label || 'NO ANALYSIS'} · {analysis ? stage.toUpperCase() : 'AWAITING SYNTHESIS'}<br /><span>AI GENERATED VIEW · {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED</span></>}
                </div>

                <ReconstructionProgress
                  progress={reconstructionProgress}
                  onCancel={cancelReconstruction}
                  onRetry={retryReconstruction}
                />

                {gearTypeNeedsConfirmation && (
                  <div className="gear-type-confirmation" role="alert">
                    <div className="gear-type-confirmation-copy">
                      <strong>GEAR TYPE UNCONFIRMED</strong>
                      <span>Tooth count alone does not identify the tooth form. Select the type before accepting geometry, CAD or health results.</span>
                    </div>
                    <select
                      className="gear-type-confirmation-select"
                      value=""
                      aria-label="Confirm gear type"
                      onChange={(event) => handleConfirmGearType(event.target.value)}
                    >
                      <option value="" disabled>Confirm gear type…</option>
                      {GEAR_TYPES.filter((type) => type !== 'unknown').map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                )}

                {!currentAnalysis ? (
                  <div className="viewport-hint">
                    <Icon>view_in_ar</Icon>
                    <p>No component analysis yet.<br />Run synthesis from the upload page or load a sample part.</p>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                      <button className="secondary" onClick={() => setPage('upload')}>
                        <Icon>upload</Icon> Upload Component
                      </button>
                      <button className="primary" onClick={loadSampleGear}>
                        <Icon>model_training</Icon> Load Sample Gear
                      </button>
                    </div>
                  </div>
                ) : !ready ? (
                  <div className="viewport-hint">
                    <Icon>precision_manufacturing</Icon>
                    <p>Generating reconstruction…</p>
                    <ProgressStepper index={stageIndex} />
                  </div>
                ) : (
                  <MultiViewportGrid
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    machineryState={machineryState}
                    activeComponentId={activeComponentId}
                    setActiveComponentId={setActiveComponentId}
                    selectedComponentIds={selectedComponentIds}
                    setSelectedComponentIds={setSelectedComponentIds}
                    wire={wire}
                    grid={grid}
                    stress={stress}
                    dims={dims}
                    autoRotate={autoRotate}
                    illumination={illumination}
                    illuminationIntensity={illuminationIntensity}
                    theme={theme}
                    resetKey={resetKey}
                    selectedFeatureId={selectedFeatureId}
                    hoveredFeatureId={hoveredFeatureId}
                    modelBaseColor={modelBaseColor}
                    viewportBackgroundColor={viewportBackgroundColor}
                    ready={ready}
                    onOpenImageManager={() => {
                      setSelectedContextTool('components');
                      setActiveLeftTab('components');
                      handleToggleLeftPanel(true);
                    }}
                  />
                )}

                {/* Floating PiP Toggle Button */}
                {ready && (
                  <div className="viewport-pip-toggle-floating">
                    <button
                      className="floating-tool-pill"
                      onClick={() => setPipVisible(true)}
                      title="Switch to Picture-in-Picture mode (moves 3D viewport into floating window)"
                    >
                      <Icon>picture_in_picture_alt</Icon> PiP Viewer
                    </button>
                  </div>
                )}
              </section>
            </div>
          );

          // Dynamic slot resolver
          const slotMap = {
            left: null,
            right: null,
            bottom: null,
            center: null,
          };

          const panelActive = {
            contextual: Boolean(isLeftPanelOpen),
            manufacturing: Boolean(isMfgActive),
            cost: Boolean(isMfgActive && !isCostPanelCollapsed),
            workspace: Boolean(!isWorkspaceClosed),
          };

          const panelTargetSlots = {
            contextual: contextualPanelSlot || 'left',
            manufacturing: mfgPanelSlot || 'right',
            cost: costPanelSlot || 'bottom',
            workspace: workspaceSlot || 'center',
          };

          Object.entries(panelTargetSlots).forEach(([panelKey, slot]) => {
            if (panelActive[panelKey] && slot && slot !== 'floating') {
              slotMap[slot] = panelKey;
            }
          });

          // Ensure workspace is in center if center is unassigned and workspace is active
          if (!slotMap.center && panelActive.workspace) {
            slotMap.center = 'workspace';
          }

          const leftSlotPanel = slotMap.left;
          const rightSlotPanel = slotMap.right;
          const bottomSlotPanel = slotMap.bottom;
          const centerSlotPanel = slotMap.center;

          const getPanelByKey = (key, slot) => {
            if (key === 'contextual') return renderContextualPanel(slot);
            if (key === 'manufacturing') return renderManufacturingPanel(slot);
            if (key === 'cost') return renderCostPanel(slot);
            if (key === 'workspace') return renderWorkspacePanel(slot);
            return null;
          };

          // Fullscreen Maximize Handling for any of the 4 panels
          if (isLeftPanelMaximized && leftSlotPanel) {
            return (
              <div className="workspace-middle-row">
                <div className="workspace-maximized-panel-wrap">
                  {getPanelByKey(leftSlotPanel, 'left')}
                </div>
              </div>
            );
          }
          if (isMfgPanelMaximized && rightSlotPanel) {
            return (
              <div className="workspace-middle-row">
                <div className="workspace-maximized-panel-wrap">
                  {getPanelByKey(rightSlotPanel, 'right')}
                </div>
              </div>
            );
          }
          if (isCostPanelMaximized && bottomSlotPanel) {
            return (
              <div className="workspace-middle-row">
                <div className="workspace-maximized-panel-wrap">
                  {getPanelByKey(bottomSlotPanel, 'bottom')}
                </div>
              </div>
            );
          }
          if (isWorkspaceMaximized) {
            return (
              <div className="workspace-middle-row">
                <div className="workspace-maximized-panel-wrap">
                  {renderWorkspacePanel('center')}
                </div>
              </div>
            );
          }

          return (
            <div className="workspace-middle-row">
              {/* Drag Event Blocker Shield during active resize or panel drag */}
              {(isResizingDivider || draggedPanel) && (
                <div className="workspace-drag-shield" />
              )}

              {/* Visual Dock Drop Overlay when dragging a panel to reposition */}
              {draggedPanel && (
                <DockDropOverlay
                  activeDockZone={hoveredDockZone}
                  draggedPanelTitle={
                    draggedPanel === 'contextual' ? 'Left Contextual Panel'
                      : draggedPanel === 'manufacturing' ? 'Manufacturing Decision Panel'
                        : draggedPanel === 'cost' ? 'Cost Estimation Panel'
                          : '3D Workspace'
                  }
                  dragPos={dragMousePos}
                />
              )}

              {/* 1. Left Dock Slot */}
              {leftSlotPanel && (
                getPanelByKey(leftSlotPanel, 'left')
              )}

              {/* Left Vertical Divider */}
              {leftSlotPanel && (
                <div
                  className="workspace-col-divider left-divider"
                  onMouseDown={handleMouseDownLeftResizer}
                  title="Drag to resize left panel column"
                />
              )}

              {/* 2. Center Column: Center Panel (Top) + Bottom Dock Slot */}
              <div className="workspace-center-column">
                {!pipVisible ? (
                  <>
                    <section className="workspace-main-area">
                      {centerSlotPanel ? (
                        getPanelByKey(centerSlotPanel, 'center')
                      ) : (
                        <div className="workspace-closed-placeholder">
                          <Icon className="closed-icon">view_in_ar</Icon>
                          <h3>3D WORKSPACE WINDOW CLOSED</h3>
                          <p>The interactive 3D model viewport has been closed. You can restore it anytime.</p>
                          <button className="primary" onClick={() => updateLayout({ isWorkspaceClosed: false })}>
                            <Icon>visibility</Icon> Restore 3D Workspace
                          </button>
                        </div>
                      )}
                    </section>

                    {/* Horizontal Resize Divider between Viewport and Bottom Dock Slot */}
                    {bottomSlotPanel && (
                      <div
                        className="center-col-divider"
                        onMouseDown={handleMouseDownCostResizer}
                        title="Drag to resize bottom docked panel"
                      />
                    )}

                    {/* Bottom Dock Slot */}
                    {bottomSlotPanel && (
                      <div className="workspace-bottom-dock-slot" style={costPanelHeight ? { height: `${costPanelHeight}px` } : undefined}>
                        {getPanelByKey(bottomSlotPanel, 'bottom')}
                      </div>
                    )}
                  </>
                ) : (
                  /* PiP MODE: 3D Workspace is popped out into floating PipWorkbench */
                  bottomSlotPanel ? (
                    <div className="workspace-center-pip-takeover">
                      {getPanelByKey(bottomSlotPanel, 'bottom')}
                    </div>
                  ) : (
                    <div className="workspace-center-pip-placeholder">
                      <Icon className="pip-placeholder-icon">picture_in_picture_alt</Icon>
                      <h3>3D VIEWPORT ACTIVE IN PICTURE-IN-PICTURE</h3>
                      <p>The interactive 3D model is active in the floating PiP window. Other panels occupy this space.</p>
                      <button className="primary" onClick={() => setPipVisible(false)}>
                        <Icon>open_in_full</Icon> Restore Viewport to Workspace
                      </button>
                    </div>
                  )
                )}
              </div>

              {/* Right Vertical Divider */}
              {rightSlotPanel && (
                <div
                  className="workspace-col-divider right-divider"
                  onMouseDown={handleMouseDownRightResizer}
                  title="Drag to resize right panel column"
                />
              )}

              {/* 3. Right Dock Slot */}
              {rightSlotPanel && (
                getPanelByKey(rightSlotPanel, 'right')
              )}

              {/* Movable, Resizable, Dockable PiP 3D Viewer */}
              {pipVisible && ready && (
                <PipWorkbench
                  analysis={activeReconstructionAnalysis}
                  machineryState={machineryState}
                  ready={ready}
                  wire={wire}
                  setWire={setWire}
                  grid={grid}
                  setGrid={setGrid}
                  stress={stress}
                  setStress={setStress}
                  dims={dims}
                  setDims={setDims}
                  autoRotate={autoRotate}
                  setAutoRotate={setAutoRotate}
                  illumination={illumination}
                  illuminationIntensity={illuminationIntensity}
                  theme={theme}
                  resetKey={resetKey}
                  setResetKey={setResetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  modelBaseColor={modelBaseColor}
                  viewportBackgroundColor={viewportBackgroundColor}
                  label={label}
                  conf={conf}
                  onDockToMain={() => setPipVisible(false)}
                  onClose={() => setPipVisible(false)}
                  dimensionList={dimensionList}
                  ReconstructedViewport={ReconstructedViewport}
                />
              )}
            </div>
          );
        })()}
      </main>

      {/* Engineering Report Editor Dialog Modal */}
      {isReportDialogOpen && (
        <ReportEditorDialog
          isOpen={isReportDialogOpen}
          onClose={() => setIsReportDialogOpen(false)}
          analysis={activeReconstructionAnalysis}
          decisions={decisions}
          confirmedCategories={confirmedCategories}
          quantity={quantity}
          mfgData={mfgData}
          images={images}
        />
      )}

      {/* Report Incomplete Guidance Notice Modal */}
      {reportNoticeOpen && (
        <div
          className="report-dialog-backdrop"
          onClick={() => setReportNoticeOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="report-notice-modal" onClick={e => e.stopPropagation()}>
            <div className="report-notice-header">
              <Icon className="notice-icon">info</Icon>
              <h3>MANUFACTURING SPECIFICATION REQUIRED</h3>
            </div>
            <p className="report-notice-message">
              Complete the manufacturing specification first to access the Engineering Report.
            </p>
            <p className="report-notice-sub">
              Engineering specification documents require confirmed alloy metallurgy, tolerance standards, and heat treatment parameters.
            </p>
            <div className="report-notice-actions">
              <button
                className="primary"
                onClick={() => {
                  setReportNoticeOpen(false);
                  setIsManufacturingActive(true);
                }}
              >
                <Icon>precision_manufacturing</Icon> Open Manufacture Workspace
              </button>
              <button
                className="secondary"
                onClick={() => setReportNoticeOpen(false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* What-If Simulator Modal when toggled */}
      {activeTab === 'whatif' && (
        <div
          className="report-dialog-backdrop"
          onClick={() => setActiveTab('workbench')}
          role="dialog"
          aria-modal="true"
          aria-label="Engineering What-If Simulator"
        >
          <div className="report-editor-card" onClick={e => e.stopPropagation()}>
            <div className="report-editor-topbar">
              <div className="report-editor-title-group">
                <Icon>tune</Icon>
                <div>
                  <h2 className="editor-modal-title">ENGINEERING WHAT-IF SIMULATOR</h2>
                  <span className="editor-modal-sub">Parametric Stress, Mass &amp; Envelope Verification</span>
                </div>
              </div>
              <button className="secondary" onClick={() => setActiveTab('workbench')}>
                <Icon>close</Icon>
              </button>
            </div>
            <div className="report-editor-body">
              <WhatIfSimulator
                analysis={currentAnalysis}
                scenarioParams={scenarioParams}
                setScenarioParams={setScenarioParams}
                recommendations={recommendations}
                deselectedRecommendations={deselectedRecommendations}
                onToggleRecommendation={handleToggleRecommendation}
                onResetRecommendations={handleResetRecommendations}
                onConfirm={handleConfirmScenario}
                isGeometryValid={isGeometryValid}
                geometryError={geometryError}
                warnings={warnings}
                impactStatus={impactStatus}
                materialVolumeImpact={materialVolumeImpact}
                ready={ready}
                onOpenReport={() => {
                  setActiveTab('workbench');
                  setIsReportDialogOpen(true);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Export Window Modal when toggled */}
      {activeTab === 'export' && (
        <div
          className="report-dialog-backdrop"
          onClick={() => setActiveTab('workbench')}
          role="dialog"
          aria-modal="true"
          aria-label="Engineering Exporters"
        >
          <div className="report-editor-card" onClick={e => e.stopPropagation()}>
            <div className="report-editor-topbar">
              <div className="report-editor-title-group">
                <Icon>download</Icon>
                <div>
                  <h2 className="editor-modal-title">EXPORT ENGINEERING WORK WINDOW</h2>
                  <span className="editor-modal-sub">CAD Formats, 3D Meshes, FEA Simulation Decks, CNC G-Code</span>
                </div>
              </div>
              <button className="secondary" onClick={() => setActiveTab('workbench')}>
                <Icon>close</Icon>
              </button>
            </div>
            <div className="report-editor-body">
              <ExportWorkWindow analysis={activeReconstructionAnalysis} mfgData={mfgData} />
            </div>
          </div>
        </div>
      )}

      {/* 2D Engineering Drawing Modal */}
      {ready && showDrawing && (
        <EngineeringDrawingModal
          analysis={activeReconstructionAnalysis}
          manufacturingIntelligence={mfgData}
          onClose={() => setShowDrawing(false)}
        />
      )}

      {/* Classical Report Modal if triggered directly */}
      {showReport && (
        <EngineeringReportModal
          analysis={currentAnalysis}
          scenarioParams={effectiveScenarioParams}
          isGeometryValid={isGeometryValid}
          geometryError={geometryError}
          warnings={warnings}
          impactStatus={impactStatus}
          materialVolumeImpact={materialVolumeImpact}
          images={images}
          onClose={() => setShowReport(false)}
        />
      )}
    </>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('Reforge Interface Error caught by ErrorBoundary:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: 'var(--error-accent, #DE822B)',
          background: 'var(--error-bg, #0c0805)',
          fontFamily: "'JetBrains Mono', monospace",
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
        }}>
          <h2 style={{ letterSpacing: '0.08em', margin: 0 }}>SYSTEM NOTICE // REFORGE WORKSPACE RECOVERY</h2>
          <p style={{ color: 'var(--error-text, #ff8585)', maxWidth: '640px', textAlign: 'center', lineHeight: '1.6', fontSize: '13px' }}>
            {this.state.error?.message || 'A render interruption occurred.'}
          </p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
            <button
              className="primary"
              style={{ padding: '8px 16px', cursor: 'pointer' }}
              onClick={() => {
                resetWorkspaceLayout();
                window.location.reload();
              }}
            >
              Reset Layout & Reload
            </button>
            <button
              className="secondary"
              style={{ padding: '8px 16px', cursor: 'pointer' }}
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Retry Render
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('reforge_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { }
    return 'dark';
  });

  const toggleTheme = useCallback(() => {
    document.documentElement?.classList.add('theme-animating');
    if (themeTransitionTimerRef.current) window.clearTimeout(themeTransitionTimerRef.current);
    themeTransitionTimerRef.current = window.setTimeout(() => {
      document.documentElement?.classList.remove('theme-animating');
      themeTransitionTimerRef.current = null;
    }, 360);
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('reforge_theme', next);
      } catch (e) { }
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') {
      document.documentElement.classList.add('theme-light');
      document.documentElement.classList.remove('theme-dark');
      document.body?.classList?.add('theme-light');
      document.body?.classList?.remove('theme-dark');
    } else {
      document.documentElement.classList.add('theme-dark');
      document.documentElement.classList.remove('theme-light');
      document.body?.classList?.add('theme-dark');
      document.body?.classList?.remove('theme-light');
    }
  }, [theme]);

  useEffect(() => () => {
    if (themeTransitionTimerRef.current) window.clearTimeout(themeTransitionTimerRef.current);
  }, []);

  const [page, setPage] = useState('home');
  const [images, setImages] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [stage, setStage] = useState('idle');
  const [analysisVersion, setAnalysisVersion] = useState(0);
  const [reconstructionReference, setReconstructionReference] = useState({});
  const [reconstructionProgress, setReconstructionProgress] = useState(
    () => createReconstructionProgress(1, RECONSTRUCTION_IDLE)
  );
  const reconstructionControllerRef = useRef(null);
  const reconstructionAttemptRef = useRef(0);
  const reconstructionCancelledRef = useRef(false);
  const conditionRequestRef = useRef(null);
  const themeTransitionTimerRef = useRef(null);

  // Machinery Context State
  const [machineryState, setMachineryState] = useState(() => createInitialMachineryState());
  const [lastAnalyzedSnapshot, setLastAnalyzedSnapshot] = useState(null);
  const [viewMode, setViewMode] = useState('single'); // 'single' | 'dual' | 'quad' | 'assembly'
  const [activeComponentId, setActiveComponentId] = useState('comp-primary-gear');
  const [selectedComponentIds, setSelectedComponentIds] = useState(['comp-primary-gear']);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const applyReconstructionProgress = useCallback((event) => {
    setReconstructionProgress((previous) => applyReconstructionEvent(previous, event));
  }, []);

  const isReconstructionCancelled = useCallback(() => (
    reconstructionCancelledRef.current || Boolean(reconstructionControllerRef.current?.signal.aborted)
  ), []);

  const cancelReconstruction = useCallback(() => {
    reconstructionCancelledRef.current = true;
    reconstructionControllerRef.current?.abort();
    applyReconstructionProgress({ type: 'cancelled', message: 'Reconstruction cancelled.' });
    setStage('idle');
  }, [applyReconstructionProgress]);

  const startReconstruction = useCallback(async () => {
    const primary = machineryState?.primaryGear;
    const companion = machineryState?.companionGear;
    if (!primary?.images?.length) return;

    reconstructionControllerRef.current?.abort();
    const attempt = reconstructionAttemptRef.current + 1;
    reconstructionAttemptRef.current = attempt;
    reconstructionCancelledRef.current = false;

    const controller = new AbortController();
    reconstructionControllerRef.current = controller;
    setReconstructionProgress(createReconstructionProgress(attempt, RECONSTRUCTION_RUNNING));
    setStage('analysing');

    try {
      const primaryRef = buildReference(reconstructionReference);
      const pAnalysis = await analyzeComponent(primary.images, primaryRef, {
        onProgress: (event) => applyReconstructionProgress({ ...event, attempt }),
        signal: controller.signal,
        // The backend already retries model candidates and optional services.
        // A whole-pipeline retry here duplicates every expensive stage.
        retries: 0,
      });
      if (reconstructionCancelledRef.current) return;

      let cAnalysis = null;
      if (companion?.images?.length) {
        applyReconstructionProgress({
          stage: 'dataset-matching',
          status: 'running',
          attempt,
          message: 'Analysing companion gear…',
        });
        cAnalysis = await analyzeComponent(companion.images, {}, {
          signal: controller.signal,
          retries: 0,
        });
        if (reconstructionCancelledRef.current) return;
        applyReconstructionProgress({
          stage: 'dataset-matching',
          status: 'complete',
          attempt,
          message: 'Companion gear matched.',
        });
      }
      if (reconstructionCancelledRef.current) return;

      const updatedMachinery = {
        ...machineryState,
        primaryGear: {
          ...machineryState.primaryGear,
          analysis: pAnalysis,
          reference: primaryRef,
        },
        companionGear: machineryState.companionGear
          ? { ...machineryState.companionGear, analysis: cAnalysis }
          : null,
      };
      setMachineryState(updatedMachinery);
      setLastAnalyzedSnapshot(createMachinerySnapshot(updatedMachinery));
      setAnalysis(pAnalysis);
      setActiveComponentId(primary.id);
      setStage('extracting');
      setPage('workbench');
    } catch (error) {
      if (isCancellationError(error) || controller.signal.aborted || reconstructionCancelledRef.current) {
        reconstructionCancelledRef.current = true;
        applyReconstructionProgress({ type: 'cancelled', attempt, message: 'Reconstruction cancelled.' });
        setStage('idle');
        return;
      }
      applyReconstructionProgress({
        type: 'failed',
        attempt,
        message: error.message || 'Analysis failed. Please try again.',
      });
      setStage('idle');
    }
  }, [
    machineryState,
    reconstructionReference,
    setMachineryState,
    setLastAnalyzedSnapshot,
    setAnalysis,
    setActiveComponentId,
    setStage,
    setPage,
    applyReconstructionProgress,
  ]);

  const retryReconstruction = useCallback(() => {
    startReconstruction();
  }, [startReconstruction]);

  // Condition evidence is image-space diagnostics. It is fetched only when a
  // user opens the health panel or heatmap, never during geometry build.
  const ensureConditionAssessment = useCallback(async (targetAnalysis, componentImages = []) => {
    if (!targetAnalysis || targetAnalysis.conditionAssessment) return;
    if (!Array.isArray(componentImages) || componentImages.length === 0) return;
    if (conditionRequestRef.current === targetAnalysis) return;
    conditionRequestRef.current = targetAnalysis;

    try {
      const conditionAssessment = await analyzeCondition(componentImages, targetAnalysis);
      if (!conditionAssessment) return;
      const enrichedAnalysis = { ...targetAnalysis, conditionAssessment };
      let primaryGear = machineryState.primaryGear;
      let companionGear = machineryState.companionGear;
      let additionalComponents = machineryState.additionalComponents;
      let changed = false;

      if (primaryGear?.analysis === targetAnalysis) {
        primaryGear = { ...primaryGear, analysis: enrichedAnalysis };
        changed = true;
      }
      if (companionGear?.analysis === targetAnalysis) {
        companionGear = { ...companionGear, analysis: enrichedAnalysis };
        changed = true;
      }
      if (Array.isArray(additionalComponents) && additionalComponents.some((comp) => comp.analysis === targetAnalysis)) {
        additionalComponents = additionalComponents.map((comp) => (
          comp.analysis === targetAnalysis ? { ...comp, analysis: enrichedAnalysis } : comp
        ));
        changed = true;
      }

      setAnalysis((previous) => previous === targetAnalysis ? enrichedAnalysis : previous);
      if (changed) {
        const nextMachineryState = {
          ...machineryState,
          primaryGear,
          companionGear,
          additionalComponents,
        };
        setMachineryState(nextMachineryState);
        setLastAnalyzedSnapshot(createMachinerySnapshot(nextMachineryState));
      }
    } catch (error) {
      console.warn('Condition analysis failed:', error?.message || error);
    } finally {
      conditionRequestRef.current = null;
    }
  }, [
    machineryState,
    setAnalysis,
    setMachineryState,
    setLastAnalyzedSnapshot,
  ]);

  useEffect(() => () => reconstructionControllerRef.current?.abort(), []);

  const isDirty = useMemo(() => {
    return hasDirtyContext(machineryState, lastAnalyzedSnapshot);
  }, [machineryState, lastAnalyzedSnapshot]);

  const handleRegenerate = useCallback(async () => {
    if (isRegenerating) return;
    setIsRegenerating(true);
    try {
      const primary = machineryState?.primaryGear;
      const companion = machineryState?.companionGear;
      const additions = machineryState?.additionalComponents || [];

      // Re-run analysis for primary if it has images
      let pAnalysis = primary?.analysis;
      if (primary?.images?.length) {
        pAnalysis = await analyzeComponent(primary.images, {
          ...(primary.reference || {}),
          name: primary.name || '',
          notes: primary.notes || '',
        });
      }

      // Re-run analysis for companion if it has images
      let cAnalysis = companion?.analysis;
      if (companion?.images?.length) {
        cAnalysis = await analyzeComponent(companion.images, {
          ...(companion.reference || {}),
          name: companion.name || '',
          notes: companion.notes || '',
        });
      }

      // Re-run analysis for additions that have images
      const updatedAdditions = await Promise.all(
        additions.map(async (comp) => {
          if (comp.images?.length) {
            try {
              const compAnalysis = await analyzeComponent(comp.images, {
                ...(comp.reference || {}),
                name: comp.name || '',
                notes: comp.notes || '',
              });
              return { ...comp, analysis: compAnalysis };
            } catch {
              return comp;
            }
          }
          return comp;
        })
      );

      const nextState = {
        ...machineryState,
        primaryGear: primary ? { ...primary, analysis: pAnalysis } : null,
        companionGear: companion ? { ...companion, analysis: cAnalysis } : null,
        additionalComponents: updatedAdditions,
      };

      const newSnapshot = createMachinerySnapshot(nextState);
      setMachineryState(nextState);
      setLastAnalyzedSnapshot(newSnapshot);
      if (pAnalysis) {
        setAnalysis(pAnalysis);
      }
    } catch (err) {
      console.error('Regeneration failed:', err);
    } finally {
      setIsRegenerating(false);
    }
  }, [machineryState, isRegenerating]);

  const updateImages = useCallback((next) => {
    setImages(next);
    setAnalysis(null);
    setStage('idle');
    setReconstructionProgress(createReconstructionProgress(1, RECONSTRUCTION_IDLE));
  }, []);

  const updateAnalysis = useCallback((result) => {
    setAnalysis(result);
    if (result) setAnalysisVersion(v => v + 1);
  }, []);

  const value = useMemo(() => ({
    page, setPage,
    images, setImages: updateImages,
    analysis, setAnalysis: updateAnalysis,
    stage, setStage,
    analysisVersion,
    reconstructionReference, setReconstructionReference,
    reconstructionProgress,
    applyReconstructionProgress,
    startReconstruction,
    cancelReconstruction,
    retryReconstruction,
    isReconstructionCancelled,
    ensureConditionAssessment,
    machineryState, setMachineryState,
    lastAnalyzedSnapshot, setLastAnalyzedSnapshot,
    viewMode, setViewMode,
    activeComponentId, setActiveComponentId,
    selectedComponentIds, setSelectedComponentIds,
    handleRegenerate,
    isRegenerating,
    isDirty,
    theme,
    toggleTheme,
  }), [
    page, images, analysis, stage, updateImages, updateAnalysis, analysisVersion,
    reconstructionReference, reconstructionProgress, applyReconstructionProgress,
    startReconstruction, cancelReconstruction, retryReconstruction, isReconstructionCancelled,
    ensureConditionAssessment,
    machineryState, lastAnalyzedSnapshot, viewMode, activeComponentId,
    selectedComponentIds, handleRegenerate, isRegenerating, isDirty,
    theme, toggleTheme
  ]);

  return (
    <ErrorBoundary>
      <AppContext.Provider value={value}>
        {page === 'home' ? <Landing /> : page === 'upload' ? <Upload /> : <Workbench />}
      </AppContext.Provider>
    </ErrorBoundary>
  );
}

// Vite can re-evaluate the entry module during HMR. Reusing the same root
// prevents a second createRoot() on #root and the stale-node removeChild crash.
const rootContainer = document.getElementById('root');
const appRoot = rootContainer._reforgeAppRoot || createRoot(rootContainer);
rootContainer._reforgeAppRoot = appRoot;

appRoot.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
