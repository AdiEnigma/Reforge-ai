import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import './styles.css';
import { ApiError, analyzeComponent, analyzeComponentDetailed, buildCad, fetchCadMesh, runAnalysisJob, sendChatMessage } from './lib/api.js';
import { fetchManufacturingIntelligence } from './lib/manufacturing.js';
import { fetchMaterialAlternatives } from './lib/material-comparison.js';
import { normalizeFeatures } from './lib/features.js';
import { buildEngineeringContext, getEngineeringSuggestions } from './lib/engineering-context.js';
import { buildDrawingModel, renderDrawingToSvg, exportSvg, exportPng, exportPdf } from './lib/drawing/index.js';
import { buildModel, buildAssemblyScene, dimensionList, resolveLabel } from './lib/reconstruct.js';
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
import { ExportWorkWindow } from './components/ExportWorkWindow.jsx';
import { ReconstructedViewport } from './components/ReconstructedViewport.jsx';
import {
  dimensionRows,
  dimensionSourceLabel,
  formatDimensionValue,
  bboxDimensionRows,
} from './lib/dimensions.js';

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

function GearCanvas() {
  const mount = useRef(null);
  useEffect(() => {
    const host = mount.current, scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 1000); camera.position.z = 15;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); host.appendChild(renderer.domElement);
    const shape = new THREE.Shape(); const teeth = 8, radius = 3.2, tooth = .8;
    shape.moveTo(radius, 0); for (let i = 0; i < teeth; i++) { const a = i * Math.PI * 2 / teeth, s = Math.PI * 2 / teeth / 4; shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius); shape.lineTo(Math.cos(a + s) * (radius + tooth), Math.sin(a + s) * (radius + tooth)); shape.lineTo(Math.cos(a + s * 2) * (radius + tooth), Math.sin(a + s * 2) * (radius + tooth)); shape.lineTo(Math.cos(a + s * 3) * radius, Math.sin(a + s * 3) * radius); } shape.lineTo(radius, 0);
    const hole = new THREE.Path(); hole.absarc(0, 0, 2.2, 0, Math.PI * 2, false); shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: .25, bevelEnabled: true, bevelSegments: 12, steps: 2, curveSegments: 64, bevelSize: .05, bevelThickness: .05 }); geo.center();
    const material = new THREE.MeshStandardMaterial({ color: '#2A0E06', metalness: .8, roughness: .45, emissive: '#0a0301', emissiveIntensity: .2 });
    const gear = new THREE.Mesh(geo, material); const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 22), new THREE.LineBasicMaterial({ color: '#DE822B' })); gear.add(edges); scene.add(gear);
    [1, -1].forEach(z => { const ring = new THREE.Mesh(new THREE.RingGeometry(2.15, 2.28, 64), new THREE.MeshBasicMaterial({ color: '#DE822B', side: THREE.DoubleSide })); ring.position.z = z * .14; gear.add(ring); });
    scene.add(new THREE.AmbientLight('#7A4A38', .9)); const light = new THREE.PointLight('#DE822B', 2.5, 30); light.position.set(8, 8, 8); scene.add(light); const tenne = new THREE.PointLight('#B76308', 2.2, 30); tenne.position.set(-8, -8, 6); scene.add(tenne);
    const pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 }, current = { x: 0, y: 0 }; const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
    const onMove = e => { const r = host.getBoundingClientRect(); pointer.x = (e.clientX - r.left) / r.width * 2 - 1; pointer.y = -(e.clientY - r.top) / r.height * 2 + 1; target.x = (e.clientX - r.left - r.width / 2) * .0018; target.y = (e.clientY - r.top - r.height / 2) * .0018; }; host.addEventListener('pointermove', onMove);
    const resize = () => { const { width, height } = host.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false) }; const observer = new ResizeObserver(resize); observer.observe(host); resize(); let frame;
    const animate = () => { frame = requestAnimationFrame(animate); mouse.set(pointer.x, pointer.y); raycaster.setFromCamera(mouse, camera); const active = raycaster.intersectObject(gear).length > 0; material.emissive.lerp(new THREE.Color(active ? '#DE822B' : '#0a0301'), active ? .04 : .03); current.x = THREE.MathUtils.lerp(current.x, target.x, .035); current.y = THREE.MathUtils.lerp(current.y, target.y, .035); gear.rotation.x = current.y; gear.rotation.y = current.x; gear.rotation.z -= .006 * (active ? 1.8 : 1); renderer.render(scene, camera) }; animate();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); host.removeEventListener('pointermove', onMove); renderer.dispose(); geo.dispose(); material.dispose(); host.replaceChildren(); };
  }, []);
  return <div className="gear-canvas" ref={mount} aria-hidden="true" />;
}

function Nav() {
  const { setPage } = useApp();
  return (
    <nav>
      <button className="brand" onClick={() => setPage('home')}>ReForge AI</button>
      <div className="navlinks">
        <button onClick={() => setPage('workbench')}>Workbench</button>
      </div>
      <button className="navcta" onClick={() => setPage('upload')}>Upload Component</button>
    </nav>
  );
}

function Landing() {
  const { setPage } = useApp();
  return (
    <>
      <Nav />
      <main className="landing">
        <section className="hero">
          <GearCanvas />
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
             : value >= 15  ? `${arrow} ${abs}% ${unit === 'weight' ? 'heavier' : 'more expensive'}`
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
    setStage,
    setAnalysis,
    setLastAnalyzedSnapshot,
    setActiveComponentId,
    requestCadBuild,
    adoptCadBuildFromJob,
  } = useApp();

  const [activeUploadSlot, setActiveUploadSlot] = useState('primary'); // 'primary' | 'companion' | 'surroundings'
  const [reference, setReference] = useState({});
  const [error, setError] = useState('');
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

  const reconstruct = async () => {
    const pImages = primary?.images || [];
    if (!pImages.length) {
      setError('Add at least one Primary Gear image to start reconstruction.');
      return;
    }
    setError('');
    setStage('analysing');
    try {
      const primaryRef = buildReference(reference);
      let job = null;
      try {
        job = await runAnalysisJob(pImages, primaryRef);
      } catch (jobError) {
        if (!(jobError instanceof ApiError) || ![0, 404, 405, 501].includes(jobError.status)) {
          throw jobError;
        }
        console.warn('Job API unavailable; using blocking analysis.', jobError.message);
      }

      if (job && job.state === 'failed' && !job.analysis) {
        throw new Error(job.error || 'Analysis job failed.');
      }
      const pAnalysis = job?.analysis
        ? job.analysis
        : (await analyzeComponentDetailed(pImages, primaryRef)).analysis;

      let cAnalysis = null;
      if (companion?.images?.length) {
        cAnalysis = await analyzeComponent(companion.images, {});
      }

      const updatedMachinery = {
        ...machineryState,
        primaryGear: {
          ...machineryState.primaryGear,
          analysis: pAnalysis,
          reference: primaryRef,
        },
        companionGear: machineryState.companionGear
          ? {
              ...machineryState.companionGear,
              analysis: cAnalysis,
            }
          : null,
      };

      const initialSnapshot = createMachinerySnapshot(updatedMachinery);
      setMachineryState(updatedMachinery);
      setLastAnalyzedSnapshot(initialSnapshot);
      setAnalysis(pAnalysis);
      setActiveComponentId(primary.id);
      setStage('extracting');
      setPage('workbench');
      if (job) {
        await adoptCadBuildFromJob(job, pAnalysis);
      } else {
        requestCadBuild(pAnalysis, primaryRef);
      }
    } catch (err) {
      setError(err.message || 'Analysis failed. Please try again.');
      setStage('idle');
    }
  };

  const primaryCount = primary?.images?.length || 0;
  const companionCount = companion?.images?.length || 0;
  const surroundingsCount = surroundings?.images?.length || 0;

  return (
    <>
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
        <div className="copilot-tab-bar" style={{ marginBottom: '16px', borderRadius: '3px 3px 0 0' }}>
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

        {/* Previews Area */}
        <section className="preview-area">
          <div>
            <p className="eyebrow">
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
    </>
  );
}

const PARAM_DEFINITIONS = [
  { key: 'outerDiameter', label: 'Outer Ø', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'innerDiameter', label: 'Inner Ø (bore)', unit: 'mm', min: 0.5, step: 0.5, isDim: true },
  { key: 'height', label: 'Height / Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'width', label: 'Width', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'length', label: 'Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'thickness', label: 'Thickness / Width', unit: 'mm', min: 0.5, step: 0.5, isDim: true },
  { key: 'teeth', label: 'Teeth', unit: 'count', min: 6, max: 120, step: 1, isDim: false, isInteger: true },
  { key: 'module', label: 'Module', unit: 'mm', min: 0.2, max: 20, step: 0.1, isDim: false },
  { key: 'helixAngle', label: 'Helix Angle', unit: 'deg', min: 1, max: 45, step: 1, isDim: false },
];

function isParamActive(def, analysis) {
  if (!analysis) return false;
  const val = def.isDim ? analysis.dimensions?.[def.key] : analysis[def.key];
  if (typeof val !== 'number' || !isFinite(val)) return false;
  if (def.key === 'helixAngle') return val > 0;
  if (def.key === 'innerDiameter') return val > 0;
  if (def.key === 'teeth') return val >= 6;
  return val > 0;
}

function WhatIfSimulator({
  analysis,
  scenarioParams,
  setScenarioParams,
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

  const handleParamChange = (key, rawValue, isInteger) => {
    const num = isInteger ? parseInt(rawValue, 10) : parseFloat(rawValue);
    if (isNaN(num)) return;
    setScenarioParams(prev => ({ ...prev, [key]: num }));
  };

  const handleReset = () => {
    setScenarioParams({});
  };

  return (
    <div className="whatif-container">
      <div className="whatif-header">
        <h3><Icon>tune</Icon> ENGINEERING WHAT-IF</h3>
        <p>Modify a design parameter and preview its engineering impact.</p>
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
            const baselineVal = def.isDim ? analysis.dimensions?.[def.key] : analysis[def.key];
            const currentVal = scenarioParams[def.key] ?? baselineVal;
            const diff = currentVal - baselineVal;
            const pct = baselineVal !== 0 ? (diff / baselineVal) * 100 : 0;
            const isModified = scenarioParams[def.key] !== undefined && Math.abs(diff) > 0.0001;

            const sliderMin = def.min !== undefined ? Math.min(def.min, Math.floor(baselineVal * 0.2)) : Math.max(0.1, Math.floor(baselineVal * 0.2));
            const sliderMax = Math.max(def.max || Math.ceil(baselineVal * 2.5), Math.ceil(baselineVal + 20));

            const sign = diff > 0 ? '+' : '';
            const diffFormatted = def.isInteger ? `${sign}${diff} ${def.unit}` : `${sign}${diff.toFixed(1)} ${def.unit}`;
            const pctFormatted = `${sign}${pct.toFixed(1)}%`;

            return (
              <div key={def.key} className={`param-card ${isModified ? 'param-modified' : ''}`}>
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
                    const baseVal = def.isDim ? analysis.dimensions?.[def.key] : analysis[def.key];
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
    cadBuild,
    requestCadBuild,
  } = useApp();

  const [open, setOpen] = useState(true); // Engineering Copilot Chat OPEN by default!
  const [copilotTab, setCopilotTab] = useState('chat'); // 'chat' | 'components'
  const [activeTab, setActiveTab] = useState('workbench'); // Workbench tab open by default
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pipVisible, setPipVisible] = useState(true);
  const [scenarioParams, setScenarioParams] = useState({});
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
  const [resetKey, setResetKey] = useState(0);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const historyRef = useRef([]);
  const thread = useRef(null);

  useEffect(() => {
    if (thread.current) {
      thread.current.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, thinking]);

  useEffect(() => {
    if (!analysis) return;
    if (stage === 'extracting') {
      const t = setTimeout(() => setStage('reconstructing'), 900);
      return () => clearTimeout(t);
    }
    if (stage === 'reconstructing') {
      const t = setTimeout(() => setStage('ready'), 1100);
      return () => clearTimeout(t);
    }
  }, [stage, analysis, setStage]);

  const ready = (stage === 'ready' || stage === 'idle' || !stage) && Boolean(analysis);
  const features = useMemo(() => normalizeFeatures(analysis), [analysis]);

  // Ensure manufacturing data is loaded for copilot, drawings, and reports
  useEffect(() => {
    if (!analysis) return;
    fetchManufacturingIntelligence(analysis, quantity)
      .then(res => setMfgData(res))
      .catch(() => {});
  }, [analysis, quantity]);

  // Load sample gear helper
  const loadSampleGear = useCallback(() => {
    const initial = createInitialMachineryState();
    initial.primaryGear.analysis = DEFAULT_ANALYSIS;
    setMachineryState(initial);
    setLastAnalyzedSnapshot(createMachinerySnapshot(initial));
    setAnalysis(DEFAULT_ANALYSIS);
    setStage('ready');
  }, [setMachineryState, setLastAnalyzedSnapshot, setAnalysis, setStage]);

  // Determine active component and scope
  const allComponents = useMemo(() => getAllComponents(machineryState), [machineryState]);
  const activeComp = useMemo(() => {
    return allComponents.find((c) => c.id === activeComponentId) || machineryState?.primaryGear;
  }, [allComponents, activeComponentId, machineryState]);

  const activeScope = viewMode === 'assembly' ? 'assembly' : machineryState?.companionGear ? 'pair' : 'single';

  // Build structured Engineering Context for Copilot
  const engineeringContext = useMemo(() => {
    if (!ready) return null;
    return buildEngineeringContext({
      analysis,
      manufacturingIntelligence: mfgData,
      quantity,
      features,
      materialAlternatives: null,
      machineryState,
      activeScope,
    });
  }, [ready, analysis, mfgData, quantity, features, machineryState, activeScope]);

  // Generate context-aware suggestions
  const suggestions = useMemo(() => {
    return getEngineeringSuggestions(engineeringContext);
  }, [engineeringContext]);

  // Reset scenario when a new analysis is loaded
  useEffect(() => {
    setScenarioParams({});
  }, [analysis]);

  const send = async (e, customMsg = null) => {
    if (e) e.preventDefault();
    const msgToSend = typeof customMsg === 'string' ? customMsg.trim() : text.trim();
    if (!msgToSend || thinking) return;
    setMessages(m => [...m, { role: 'user', text: msgToSend }]);
    if (!customMsg) setText('');
    setThinking(true);
    try {
      const reply = await sendChatMessage(msgToSend, engineeringContext || analysis, historyRef.current);
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

  const label = analysis ? resolveLabel(analysis) : null;
  const conf = analysis && typeof analysis.confidence === 'number' ? Math.round(analysis.confidence * 100) : null;
  const stageIndex = analysis ? (stage === 'extracting' ? 2 : stage === 'reconstructing' ? 3 : 5) : 0;

  // Geometry Validation
  const { isGeometryValid, geometryError } = useMemo(() => {
    if (!analysis) return { isGeometryValid: true, geometryError: null };
    const currentOD = scenarioParams.outerDiameter ?? analysis.dimensions?.outerDiameter;
    const currentID = scenarioParams.innerDiameter ?? analysis.dimensions?.innerDiameter;
    const currentTeeth = scenarioParams.teeth ?? analysis.teeth;

    for (const [k, v] of Object.entries(scenarioParams)) {
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
  }, [analysis, scenarioParams]);

  // Derive immutable scenario analysis for 3D reconstruction
  const scenarioAnalysis = useMemo(() => {
    if (!analysis) return null;
    if (!Object.keys(scenarioParams).length || !isGeometryValid) return analysis;

    const cloned = {
      ...analysis,
      dimensions: { ...(analysis.dimensions || {}) },
    };

    for (const def of PARAM_DEFINITIONS) {
      if (scenarioParams[def.key] !== undefined) {
        if (def.isDim) {
          cloned.dimensions[def.key] = scenarioParams[def.key];
        } else {
          cloned[def.key] = scenarioParams[def.key];
        }
      }
    }

    if (analysis.geometryRecipe) {
      cloned.geometryRecipe = JSON.parse(JSON.stringify(analysis.geometryRecipe));
      if (cloned.geometryRecipe.gear) {
        if (scenarioParams.teeth !== undefined) cloned.geometryRecipe.gear.teeth = scenarioParams.teeth;
        if (scenarioParams.module !== undefined) cloned.geometryRecipe.gear.module = scenarioParams.module;
        if (scenarioParams.helixAngle !== undefined) cloned.geometryRecipe.gear.helixAngle = scenarioParams.helixAngle;
        if (scenarioParams.height !== undefined) cloned.geometryRecipe.gear.faceWidth = scenarioParams.height;
        if (scenarioParams.thickness !== undefined && scenarioParams.height === undefined) cloned.geometryRecipe.gear.faceWidth = scenarioParams.thickness;
        if (scenarioParams.innerDiameter !== undefined) cloned.geometryRecipe.gear.boreRadius = scenarioParams.innerDiameter / 2;
      }
      if (cloned.geometryRecipe.depth) {
        if (scenarioParams.height !== undefined) cloned.geometryRecipe.depth = scenarioParams.height;
        else if (scenarioParams.thickness !== undefined) cloned.geometryRecipe.depth = scenarioParams.thickness;
        else if (scenarioParams.length !== undefined) cloned.geometryRecipe.depth = scenarioParams.length;
      }
    }

    return cloned;
  }, [analysis, scenarioParams, isGeometryValid]);

  // Approximate material volume impact
  const materialVolumeImpact = useMemo(() => {
    if (!analysis) return null;
    const od0 = analysis.dimensions?.outerDiameter;
    const id0 = analysis.dimensions?.innerDiameter || 0;
    const h0 = analysis.dimensions?.height || analysis.dimensions?.thickness;
    if (typeof od0 !== 'number' || typeof h0 !== 'number' || od0 <= 0 || h0 <= 0) {
      return null;
    }

    const odS = scenarioParams.outerDiameter ?? od0;
    const idS = scenarioParams.innerDiameter ?? id0;
    const hS = scenarioParams.height ?? (scenarioParams.thickness ?? h0);

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
  }, [analysis, scenarioParams]);

  // Deterministic warnings and impact status
  const { warnings, impactStatus } = useMemo(() => {
    if (!analysis) return { warnings: [], impactStatus: 'STABLE' };
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
      if (!isParamActive(def, analysis)) continue;
      const baseVal = def.isDim ? analysis.dimensions?.[def.key] : analysis[def.key];
      if (typeof baseVal !== 'number' || !isFinite(baseVal)) continue;

      const scenVal = scenarioParams[def.key] ?? baseVal;
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
    if (Object.keys(scenarioParams).length > 0) {
      if (maxPct > 15) {
        status = 'HIGH IMPACT';
      } else if (maxPct >= 5 || hasCriticalChange) {
        status = 'REVIEW';
      } else {
        status = 'STABLE';
      }
    }

    return { warnings: [...new Set(warnList)], impactStatus: status };
  }, [analysis, scenarioParams, isGeometryValid, geometryError]);

  const activeReconstructionAnalysis = isGeometryValid && scenarioAnalysis ? scenarioAnalysis : analysis;
  const modifiedCount = Object.keys(scenarioParams).length;

  const usingCad = cadBuild.status === 'ready' && Boolean(cadBuild.mesh);
  const cadResult = cadBuild.status === 'ready' ? cadBuild.result?.result || null : null;
  const cadDimensionSource =
    Array.isArray(cadResult?.dimensions) && cadResult.dimensions.length
      ? { dimensionsDetail: cadResult.dimensions }
      : activeReconstructionAnalysis;
  const dimensionRowsList = useMemo(
    () => dimensionRows(cadDimensionSource),
    [cadDimensionSource]
  );
  const solidBboxRows = useMemo(
    () => bboxDimensionRows(cadResult?.model?.bbox),
    [cadResult?.model?.bbox]
  );
  const hasEstimatedDimensions = dimensionRowsList.some(
    (dimension) => dimension.source === 'estimated'
  );

  const rebuildFromDimension = (key, rawValue) => {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || numeric < 0) return;
    if (key === 'teeth' && (numeric < 4 || numeric > 400)) return;
    if (key === 'helixAngle' && numeric > 60) return;
    if (key !== 'helixAngle' && key !== 'teeth' && numeric <= 0) return;
    const reference = {
      ...(machineryState?.primaryGear?.reference || {}),
      [key]: key === 'teeth' ? Math.round(numeric) : numeric,
    };
    setMachineryState((previous) =>
      previous
        ? {
            ...previous,
            primaryGear: {
              ...previous.primaryGear,
              reference,
            },
          }
        : previous
    );
    requestCadBuild(analysis, reference);
  };

  return (
    <>
      <Nav />
      <main className={`workbench ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'} ${open ? 'chat-open' : ''}`}>
        {/* Left Vertical Navigation Sidebar */}
        <aside className={`left-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Engineering Navigation">
          <div className="sidebar-top-bar">
            {!sidebarCollapsed && <span className="sidebar-brand-title">ENGINEERING TOOLS</span>}
            <button
              className="sidebar-collapse-btn"
              title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              aria-label={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              onClick={() => setSidebarCollapsed(c => !c)}
            >
              <Icon>{sidebarCollapsed ? 'chevron_right' : 'chevron_left'}</Icon>
            </button>
          </div>

          <nav className="sidebar-nav" role="tablist">
            {LEFT_TABS.map(tab => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`sidebar-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                title={tab.label}
                disabled={!ready && tab.id !== 'workbench'}
                onClick={() => {
                  setActiveTab(tab.id);
                  setPipVisible(true);
                }}
              >
                <Icon className="sidebar-tab-icon">{tab.icon}</Icon>
                {!sidebarCollapsed && <span className="sidebar-tab-label">{tab.label}</span>}
                {tab.id === 'whatif' && modifiedCount > 0 && (
                  <span className="sidebar-tab-badge">{modifiedCount}</span>
                )}
              </button>
            ))}
          </nav>

          {!sidebarCollapsed && ready && (
            <div className="sidebar-footer-card">
              <div className="sidebar-footer-row">
                <span className="sidebar-footer-dot"></span>
                <strong className="sidebar-footer-name">{label}</strong>
              </div>
              <span className="sidebar-footer-meta">{conf != null ? `${conf}% CONFIDENCE` : 'AI RECONSTRUCTED'}</span>
            </div>
          )}
        </aside>

        {/* Center Main Workspace Area */}
        <section className="workspace-main-area">
          {activeTab === 'workbench' && (
            <section className="viewport">
              <div className="cad viewport-status" aria-live="polite">
                {ready
                  ? <>● {label}{usingCad ? ' · PARAMETRIC CAD' : ' · APPROXIMATE PREVIEW'}{conf != null ? ` · CONFIDENCE ${conf}%` : ''}<br /><span>{usingCad ? 'SOLID GENERATED BY PYTHON-ENGINE' : 'AI RECONSTRUCTED'} FROM {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED{modifiedCount > 0 ? ' · WHAT-IF SCENARIO ACTIVE' : ''}</span></>
                  : <>● {label || 'NO ANALYSIS'} · {analysis ? stage.toUpperCase() : 'AWAITING SYNTHESIS'}<br /><span>AI GENERATED VIEW · {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED</span></>}
              </div>

              {!analysis ? (
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
                  autoRotate={autoRotate}
                  resetKey={resetKey}
                  selectedFeatureId={selectedFeatureId}
                  hoveredFeatureId={hoveredFeatureId}
                  ready={ready}
                  onOpenImageManager={() => setCopilotTab('components')}
                  cadMesh={cadBuild.status === 'ready' ? cadBuild.mesh : null}
                  cadMeshComponentId={machineryState?.primaryGear?.id || null}
                />
              )}

              {ready && (
                <div className="cad-export-panel" aria-live="polite">
                  {cadBuild.status === 'building' && (
                    <span className="cad-export-status">BUILDING PARAMETRIC CAD…</span>
                  )}
                  {cadBuild.status === 'ready' && !cadBuild.result?.result?.exportBlocked && (
                    <>
                      <span className="cad-export-status cad-export-ready">
                        PARAMETRIC CAD{typeof cadBuild.result?.result?.validation?.fitScore === 'number'
                          ? ` · FIT ${(cadBuild.result.result.validation.fitScore * 100).toFixed(0)}%`
                          : ''}
                      </span>
                      {cadBuild.result?.result?.stepUrl && (
                        <a href={cadBuild.result.result.stepUrl} download>STEP</a>
                      )}
                      {cadBuild.result?.result?.stlUrl && (
                        <a href={cadBuild.result.result.stlUrl} download>STL</a>
                      )}
                    </>
                  )}
                  {cadBuild.status === 'ready' && cadBuild.result?.result?.exportBlocked && (
                    <span className="cad-export-status cad-export-blocked">
                      RELATIVE PREVIEW · ENTER ONE MEASUREMENT TO ENABLE EXPORT
                    </span>
                  )}
                  {cadBuild.status === 'needs_input' && (
                    <span className="cad-export-status cad-export-blocked" title={cadBuild.error || ''}>
                      MORE DIMENSIONS NEEDED FOR PARAMETRIC CAD
                    </span>
                  )}
                  {(cadBuild.status === 'unavailable' || cadBuild.status === 'failed') && (
                    <span className="cad-export-status cad-export-blocked" title={cadBuild.error || ''}>
                      APPROXIMATE PREVIEW · CAD ENGINE UNAVAILABLE
                    </span>
                  )}
                </div>
              )}

              {ready && dims && (
                <div className="dims-overlay" aria-label="Component dimensions">
                  {hasEstimatedDimensions && (
                    <div className="dims-estimate-notice">
                      ESTIMATED DIMENSIONS · EDIT A VALUE TO MEASURE AND ANCHOR EXPORTS
                    </div>
                  )}
                  {dimensionRowsList.map((dimension) => (
                    <div className="dims-row" key={`${dimension.key}-${dimension.value}`}>
                      <span className="dims-label">
                        {dimension.label}
                        {dimension.anchor ? <span className="dims-anchor" title="Anchor dimension">●</span> : null}
                      </span>
                      <input
                        className="dims-input"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step={dimension.unit === 'count' ? '1' : '0.1'}
                        defaultValue={formatDimensionValue(dimension.value, dimension.unit)}
                        title={dimension.note || `Source: ${dimensionSourceLabel(dimension.source)}`}
                        aria-label={`${dimension.label} in ${dimension.unit}`}
                        onBlur={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && Math.abs(next - dimension.value) < 1e-9) return;
                          rebuildFromDimension(dimension.key, event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                          if (event.key === 'Escape') {
                            event.currentTarget.value = formatDimensionValue(
                              dimension.value,
                              dimension.unit
                            );
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <span className={`dims-source dims-source-${dimension.source}`}>
                        {dimensionSourceLabel(dimension.source)}
                      </span>
                    </div>
                  ))}
                  {solidBboxRows.map((dimension) => (
                    <div className="dims-row dims-row-solid" key={dimension.key}>
                      <span className="dims-label">{dimension.label}</span>
                      <span className="dims-value">
                        {formatDimensionValue(dimension.value, dimension.unit)}
                      </span>
                      <span className="dims-source dims-source-measured">
                        {dimensionSourceLabel(dimension.source)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Detected Features Overlay */}
              {ready && showFeatures && (
                <div className="viewport-overlay-panels">
                  <FeatureIdentificationPanel
                    features={features}
                    selectedFeatureId={selectedFeatureId}
                    hoveredFeatureId={hoveredFeatureId}
                    onSelectFeature={setSelectedFeatureId}
                    onHoverFeature={setHoveredFeatureId}
                  />
                </div>
              )}

              {/* Right Vertical Viewport Controls Panel */}
              <div className="viewport-controls-vertical" aria-label="Viewport Controls">
                <button
                  aria-label="Toggle automatic rotation"
                  title="Auto-rotate"
                  className={autoRotate ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setAutoRotate(value => !value)}
                >
                  <Icon>360</Icon>
                </button>
                <button
                  aria-label="Toggle wireframe"
                  title="Wireframe"
                  className={wire ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setWire(value => !value)}
                >
                  <Icon>grid_on</Icon>
                </button>
                <button
                  aria-label="Toggle FEA stress heatmap"
                  title="Stress Heatmap"
                  className={stress ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setStress(s => !s)}
                >
                  <Icon>local_fire_department</Icon>
                </button>
                <button
                  aria-label="Toggle grid"
                  title="Grid"
                  className={grid ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setGrid(value => !value)}
                >
                  <Icon>grid_3x3</Icon>
                </button>
                <button
                  aria-label="Toggle dimensions"
                  title="Dimensions"
                  className={dims ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setDims(d => !d)}
                >
                  <Icon>straighten</Icon>
                </button>
                <button
                  aria-label="Toggle detected features"
                  title="Detected Features"
                  className={showFeatures ? 'active' : ''}
                  disabled={!ready}
                  onClick={() => setShowFeatures(v => !v)}
                >
                  <Icon>center_focus_strong</Icon>
                </button>
                <button
                  aria-label="Reset viewport"
                  title="Reset View"
                  disabled={!ready}
                  onClick={() => setResetKey(value => value + 1)}
                >
                  <Icon>restart_alt</Icon>
                </button>
              </div>

              <div className="viewport-empty">
                <Icon>view_in_ar</Icon>
                <span>{ready ? 'DRAG TO ROTATE · SCROLL TO ZOOM · RIGHT-DRAG TO PAN' : 'RE:FORGE RENDERER'}</span>
              </div>
            </section>
          )}

          {activeTab === 'mfg' && (
            <div className="work-window mfg-work-window">
              <div className="work-window-topbar">
                <div className="work-window-title-group">
                  <Icon>receipt_long</Icon>
                  <h2>MANUFACTURING INTELLIGENCE WORK WINDOW</h2>
                  <span className="work-window-badge">Cost &amp; Process Synthesis</span>
                </div>
              </div>
              <div className="work-window-body">
                <ManufacturingPanel
                  analysis={analysis}
                  onData={setMfgData}
                  quantity={quantity}
                  setQuantity={setQuantity}
                />
              </div>
            </div>
          )}

          {activeTab === 'materials' && (
            <div className="work-window materials-work-window">
              <div className="work-window-topbar">
                <div className="work-window-title-group">
                  <Icon>layers</Icon>
                  <h2>MATERIAL OPTIONS WORK WINDOW</h2>
                  <span className="work-window-badge">Alloy Trade-off Matrix</span>
                </div>
              </div>
              <div className="work-window-body">
                <MaterialComparisonPanel
                  analysis={analysis}
                  manufacturingIntelligence={mfgData}
                />
              </div>
            </div>
          )}

          {activeTab === 'report' && (
            <div className="work-window report-work-window">
              <EngineeringReportModal
                analysis={analysis}
                scenarioParams={scenarioParams}
                isGeometryValid={isGeometryValid}
                geometryError={geometryError}
                warnings={warnings}
                impactStatus={impactStatus}
                materialVolumeImpact={materialVolumeImpact}
                images={images}
                isWorkWindow={true}
                onClose={() => setActiveTab('workbench')}
              />
            </div>
          )}

          {activeTab === 'drawing' && (
            <div className="work-window drawing-work-window">
              <EngineeringDrawingModal
                analysis={analysis}
                manufacturingIntelligence={mfgData}
                isWorkWindow={true}
                onClose={() => setActiveTab('workbench')}
              />
            </div>
          )}

          {activeTab === 'whatif' && (
            <div className="work-window whatif-work-window">
              <div className="work-window-topbar">
                <div className="work-window-title-group">
                  <Icon>tune</Icon>
                  <h2>ENGINEERING WHAT-IF SIMULATOR WORK WINDOW</h2>
                  <span className="work-window-badge">Parametric Stress &amp; Volume Estimation</span>
                </div>
              </div>
              <div className="work-window-body">
                <WhatIfSimulator
                  analysis={analysis}
                  scenarioParams={scenarioParams}
                  setScenarioParams={setScenarioParams}
                  isGeometryValid={isGeometryValid}
                  geometryError={geometryError}
                  warnings={warnings}
                  impactStatus={impactStatus}
                  materialVolumeImpact={materialVolumeImpact}
                  ready={ready}
                  onOpenReport={() => setActiveTab('report')}
                />
              </div>
            </div>
          )}

          {activeTab === 'export' && (
            <ExportWorkWindow analysis={activeReconstructionAnalysis} cadBuild={cadBuild} />
          )}

          {/* Picture-in-Picture Floating 3D Workbench when in other work windows */}
          {activeTab !== 'workbench' && pipVisible && (
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
              resetKey={resetKey}
              setResetKey={setResetKey}
              selectedFeatureId={selectedFeatureId}
              hoveredFeatureId={hoveredFeatureId}
              label={label}
              conf={conf}
              onDockToMain={() => setActiveTab('workbench')}
              onClose={() => setPipVisible(false)}
              dimensionList={dimensionList}
              ReconstructedViewport={ReconstructedViewport}
              cadMesh={cadBuild.status === 'ready' ? cadBuild.mesh : null}
              cadMeshComponentId={machineryState?.primaryGear?.id || null}
            />
          )}

          {/* Floating reopen button if PiP was closed */}
          {activeTab !== 'workbench' && !pipVisible && (
            <button
              className="reopen-pip-btn"
              onClick={() => setPipVisible(true)}
              title="Open Floating 3D Viewport"
              aria-label="Open Floating 3D Viewport"
            >
              <Icon>view_in_ar</Icon> 3D VIEW
            </button>
          )}
        </section>

        {/* Right Collapsible Copilot Engineering Chat */}
        <aside className={`chat ${open ? '' : 'closed'}`}>
          <button className="door" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? 'CLOSE COPILOT' : 'OPEN COPILOT'} <Icon>{open ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left'}</Icon>
          </button>
          {open && (
            <>
              <header className="chat-head">
                <div>
                  <h2><Icon>smart_toy</Icon> ENGINEERING COPILOT</h2>
                  <div className="chat-conn-status">
                    {ready ? (
                      <><span className="chat-status-dot active"></span> Connected to current model</>
                    ) : (
                      <><span className="chat-status-dot"></span> Awaiting component analysis</>
                    )}
                  </div>
                  <span>
                    {ready
                      ? `CONTEXT: ${activeScope.toUpperCase()} · ${label}${conf != null ? ` · ${conf}% CONF` : ''}`
                      : 'AWAITING COMPONENT ANALYSIS'}
                  </span>
                </div>
              </header>

              {/* Copilot Navigation Tab Switcher: Chat vs Manage Components */}
              <div className="copilot-tab-bar">
                <button
                  className={`copilot-tab-btn ${copilotTab === 'chat' ? 'active' : ''}`}
                  onClick={() => setCopilotTab('chat')}
                >
                  <Icon>chat</Icon> Chat
                </button>
                <button
                  className={`copilot-tab-btn ${copilotTab === 'components' ? 'active' : ''}`}
                  onClick={() => setCopilotTab('components')}
                >
                  <Icon>category</Icon> Manage Components
                  {isDirty && <span className="dirty-indicator" title="New visual context staged" />}
                </button>
              </div>

              {/* TAB 1: Manage Components */}
              {copilotTab === 'components' && (
                <ManageComponentsTab
                  machineryState={machineryState}
                  setMachineryState={setMachineryState}
                  onUpdateMachineryState={setMachineryState}
                  onRegenerate={handleRegenerate}
                  isRegenerating={isRegenerating}
                  isDirty={isDirty}
                  activeComponentId={activeComponentId}
                  onSelectComponent={setActiveComponentId}
                />
              )}

              {/* TAB 2: Chat */}
              {copilotTab === 'chat' && (
                <>
                  {/* Regenerate Alert Notice Banner when new visual context is staged */}
                  {isDirty && (
                    <div className="regenerate-banner" style={{ margin: '8px 12px 4px 12px' }}>
                      <div className="regenerate-banner-text">
                        <Icon>auto_mode</Icon>
                        <span>New visual context staged.</span>
                      </div>
                      <button
                        className="regenerate-btn"
                        onClick={handleRegenerate}
                        disabled={isRegenerating}
                      >
                        {isRegenerating ? 'REGENERATING…' : 'REGENERATE'}
                      </button>
                    </div>
                  )}

                  {/* Active Part Context Card */}
                  {ready && engineeringContext && (
                    <div className="chat-part-card">
                      <div className="chat-part-title">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <strong>{engineeringContext.component.name}</strong>
                          <span className={`role-tag ${activeScope === 'assembly' ? 'context' : activeScope === 'pair' ? 'companion' : 'primary'}`} style={{ fontSize: '8px', padding: '1px 5px' }}>
                            {activeScope.toUpperCase()}
                          </span>
                        </div>
                        <span className="chat-qty-tag">QTY {quantity}</span>
                      </div>
                      <div className="chat-part-meta">
                        <span>{engineeringContext.material.label}</span>
                        <span>{mfgData?.process?.recommended?.label || 'CNC Machining'}</span>
                        {mfgData?.cost && <span>₹{formatINR(mfgData.cost.low)}–₹{formatINR(mfgData.cost.high)}/u</span>}
                      </div>
                      {activeScope === 'pair' && engineeringContext.machineryContext?.relations?.gearRatio && (
                        <div className="chat-part-meta" style={{ marginTop: '4px', color: 'var(--primary)' }}>
                          <span>Gear Ratio: {engineeringContext.machineryContext.relations.gearRatio}:1</span>
                          <span>Center Dist: {engineeringContext.machineryContext.relations.centerDistanceMm} mm</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Suggested Question Chips */}
                  {ready && suggestions.length > 0 && (
                    <div className="chat-suggestions" aria-label="Suggested questions">
                      <span className="chat-suggestions-label">SUGGESTED QUESTIONS</span>
                      <div className="chat-chips-wrap">
                        {suggestions.map((q, idx) => (
                          <button
                            key={idx}
                            className="chat-chip-btn"
                            disabled={thinking}
                            onClick={() => send(null, q)}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="thread" ref={thread}>
                    {!messages.length && (
                      <div className="ai-message">
                        <Icon>smart_toy</Icon>
                        <p>I'm your engineering copilot, grounded in this component's geometry, dimensions, material, and manufacturing intelligence. Ask about process trade-offs, material alternatives, or hypothetical modifications.</p>
                      </div>
                    )}
                    {messages.map((m, i) => (
                      <div className={`${m.role}-message${m.error ? ' chat-error' : ''}`} key={i}><p>{m.text}</p></div>
                    ))}
                    {thinking && (
                      <div className="ai-message thinking">
                        <Icon>smart_toy</Icon>
                        <p>Copilot is reasoning from component geometry & manufacturing data…</p>
                      </div>
                    )}
                  </div>
                  <form className="composer" onSubmit={send}>
                    <label className="sr-only" htmlFor="question">Ask Engineering Copilot</label>
                    <span>&gt;_</span>
                    <input id="question" value={text} onChange={e => setText(e.target.value)} placeholder="Ask about this component or assembly…" />
                    <button aria-label="Send message" disabled={!text.trim() || thinking}><Icon>send</Icon></button>
                  </form>
                </>
              )}
            </>
          )}
        </aside>
        {!open && <button className="reopen" onClick={() => setOpen(true)} aria-label="Open Engineering Copilot" title="Open Engineering Copilot"><Icon>smart_toy</Icon></button>}
      </main>

      {/* Modals */}
      {ready && showDrawing && (
        <EngineeringDrawingModal
          analysis={analysis}
          manufacturingIntelligence={mfgData}
          onClose={() => setShowDrawing(false)}
        />
      )}

      {showReport && (
        <EngineeringReportModal
          analysis={analysis}
          scenarioParams={scenarioParams}
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

function App() {
  const [page, setPage] = useState('home');
  const [images, setImages] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [stage, setStage] = useState('idle');
  const [analysisVersion, setAnalysisVersion] = useState(0);
  const [cadBuild, setCadBuild] = useState({
    status: 'idle',
    analysis: null,
    result: null,
    mesh: null,
    error: null,
  });
  const cadRequestRef = useRef(0);

  const adoptCadBuildFromJob = useCallback(async (job, targetAnalysis) => {
    const requestId = ++cadRequestRef.current;
    if (!job) return;
    if (['unavailable', 'failed', 'needs_input'].includes(job.state)) {
      setCadBuild({
        status: job.state,
        analysis: targetAnalysis,
        result: job,
        mesh: null,
        error: job.error || 'CAD generation is unavailable.',
      });
      return;
    }
    let mesh = null;
    if (job.result?.meshUrl) {
      try {
        mesh = await fetchCadMesh(job.result.meshUrl);
      } catch (meshError) {
        console.warn('CAD preview could not be loaded:', meshError.message);
      }
    }
    if (requestId !== cadRequestRef.current) return;
    setCadBuild({
      status: 'ready',
      analysis: targetAnalysis,
      result: job,
      mesh,
      error: null,
    });
  }, []);

  const requestCadBuild = useCallback(async (targetAnalysis, reference) => {
    const requestId = ++cadRequestRef.current;
    if (!targetAnalysis?.geometryRecipe) {
      setCadBuild({ status: 'idle', analysis: null, result: null, mesh: null, error: null });
      return;
    }
    setCadBuild({
      status: 'building',
      analysis: targetAnalysis,
      result: null,
      mesh: null,
      error: null,
    });
    try {
      const job = await buildCad({ analysis: targetAnalysis, reference });
      if (requestId !== cadRequestRef.current) return;
      if (['unavailable', 'failed', 'needs_input'].includes(job?.state)) {
        setCadBuild({
          status: job.state,
          analysis: targetAnalysis,
          result: job,
          mesh: null,
          error: job.error || 'CAD generation is unavailable.',
        });
        return;
      }
      let mesh = null;
      if (job?.result?.meshUrl) {
        try {
          mesh = await fetchCadMesh(job.result.meshUrl);
        } catch (meshError) {
          console.warn('CAD preview could not be loaded:', meshError.message);
        }
      }
      if (requestId !== cadRequestRef.current) return;
      setCadBuild({
        status: 'ready',
        analysis: targetAnalysis,
        result: job,
        mesh,
        error: null,
      });
    } catch (error) {
      if (requestId !== cadRequestRef.current) return;
      setCadBuild({
        status: 'failed',
        analysis: targetAnalysis,
        result: null,
        mesh: null,
        error: error?.message || 'CAD generation failed.',
      });
    }
  }, []);

  // Machinery Context State
  const [machineryState, setMachineryState] = useState(() => createInitialMachineryState());
  const [lastAnalyzedSnapshot, setLastAnalyzedSnapshot] = useState(null);
  const [viewMode, setViewMode] = useState('single'); // 'single' | 'dual' | 'quad' | 'assembly'
  const [activeComponentId, setActiveComponentId] = useState('comp-primary-gear');
  const [selectedComponentIds, setSelectedComponentIds] = useState(['comp-primary-gear']);
  const [isRegenerating, setIsRegenerating] = useState(false);

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
        pAnalysis = await analyzeComponent(primary.images, primary.reference || {});
      }

      // Re-run analysis for companion if it has images
      let cAnalysis = companion?.analysis;
      if (companion?.images?.length) {
        cAnalysis = await analyzeComponent(companion.images, companion.reference || {});
      }

      // Re-run analysis for additions that have images
      const updatedAdditions = await Promise.all(
        additions.map(async (comp) => {
          if (comp.images?.length) {
            try {
              const compAnalysis = await analyzeComponent(comp.images, comp.reference || {});
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
        requestCadBuild(pAnalysis, primary?.reference || {});
      }
    } catch (err) {
      console.error('Regeneration failed:', err);
    } finally {
      setIsRegenerating(false);
    }
  }, [machineryState, isRegenerating, requestCadBuild]);

  const updateImages = useCallback((next) => {
    cadRequestRef.current += 1;
    setImages(next);
    setAnalysis(null);
    setStage('idle');
    setCadBuild({ status: 'idle', analysis: null, result: null, mesh: null, error: null });
  }, []);

  const updateAnalysis = useCallback((result) => {
    cadRequestRef.current += 1;
    setAnalysis(result);
    if (result) setAnalysisVersion(v => v + 1);
  }, []);

  const value = useMemo(() => ({
    page, setPage,
    images, setImages: updateImages,
    analysis, setAnalysis: updateAnalysis,
    stage, setStage,
    analysisVersion,
    cadBuild,
    requestCadBuild,
    adoptCadBuildFromJob,
    machineryState, setMachineryState,
    lastAnalyzedSnapshot, setLastAnalyzedSnapshot,
    viewMode, setViewMode,
    activeComponentId, setActiveComponentId,
    selectedComponentIds, setSelectedComponentIds,
    handleRegenerate,
    isRegenerating,
    isDirty,
  }), [
    page, images, analysis, stage, updateImages, updateAnalysis, analysisVersion,
    cadBuild, requestCadBuild, adoptCadBuildFromJob,
    machineryState, lastAnalyzedSnapshot, viewMode, activeComponentId,
    selectedComponentIds, handleRegenerate, isRegenerating, isDirty
  ]);

  return (
    <AppContext.Provider value={value}>
      {page === 'home' ? <Landing /> : page === 'upload' ? <Upload /> : <Workbench />}
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
