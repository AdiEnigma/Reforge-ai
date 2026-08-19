import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import './styles.css';
import { analyzeComponent, sendChatMessage } from './lib/api.js';
import { buildModel, dimensionList, resolveLabel } from './lib/reconstruct.js';

const AppContext = createContext();
const useApp = () => useContext(AppContext);
const Icon = ({ children }) => <span className="icon" aria-hidden="true">{children}</span>;

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

function createStressMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      minStress: { value: 0.0 },
      maxStress: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      void main() {
        vPosition = position;
        vNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;

      // Turbo / Jet colormap approximation
      vec3 jetHeatmap(float val) {
        float v = clamp(val, 0.0, 1.0);
        return clamp(vec3(
          1.5 - abs(v * 4.0 - 3.0),
          1.5 - abs(v * 4.0 - 2.0),
          1.5 - abs(v * 4.0 - 1.0)
        ), 0.0, 1.0);
      }

      void main() {
        // Stress distribution based on distance from center & local curvature
        float dist = length(vPosition.xy);
        float curvature = length(cross(dFdx(vNormal), dFdy(vNormal))) * 5.0;
        float stressFactor = clamp(sin(dist * 1.5) * 0.5 + 0.5 + curvature * 0.3, 0.0, 1.0);

        // Simple directional lighting
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.8));
        float diff = max(dot(normalize(vNormal), lightDir), 0.25);

        vec3 heatColor = jetHeatmap(stressFactor);
        gl_FragColor = vec4(heatColor * diff, 1.0);
      }
    `,
  });
}

function ReconstructedViewport({ analysis, wire, grid, stress, autoRotate, resetKey }) {
  const mount = useRef(null);
  const resetViewRef = useRef(null);
  const options = useRef({ wire, grid, stress, autoRotate });
  options.current = { wire, grid, stress, autoRotate };

  useEffect(() => {
    const host = mount.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const { group } = buildModel(analysis);
    scene.add(group);
    scene.add(new THREE.AmbientLight('#7a4a38', 0.6));
    const key = new THREE.DirectionalLight('#ffb77f', 0.8); key.position.set(6, 8, 10); scene.add(key);
    const fill = new THREE.PointLight('#b76308', 1.0, 25); fill.position.set(-5, -4, 6); scene.add(fill);
    const gridHelper = new THREE.GridHelper(10, 12, '#544337', '#3d332c'); gridHelper.position.z = -1.2; gridHelper.visible = false; scene.add(gridHelper);
    const originals = new Map(); group.traverse(node => { if (node.isMesh) originals.set(node.uuid, node.material); });
    const wireMaterial = new THREE.MeshBasicMaterial({ color: '#b5e67e', wireframe: true });
    const stressMaterial = createStressMaterial();
    const view = { radius: 8, theta: 0.55, phi: 1.35 }; const target = new THREE.Vector3();
    const reset = () => { view.radius = 8; view.theta = 0.55; view.phi = 1.35; target.set(0, 0, 0); }; resetViewRef.current = reset;
    let pointerMode = null, lastPoint = null, appliedWire = null, appliedStress = null;
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
      if (appliedWire !== options.current.wire || appliedStress !== options.current.stress) {
        appliedWire = options.current.wire;
        appliedStress = options.current.stress;
        group.traverse(node => {
          if (node.isMesh) {
            if (appliedWire) {
              node.material = wireMaterial;
            } else if (appliedStress) {
              node.material = stressMaterial;
            } else {
              node.material = originals.get(node.uuid);
            }
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
      stressMaterial.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [analysis]);
  useEffect(() => { resetViewRef.current?.(); }, [resetKey]);
  return <div className="model-canvas" ref={mount} aria-label="Interactive reconstructed 3D model" />;
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

function Upload() {
  const { images, setImages, setPage, stage, setStage, setAnalysis } = useApp();
  const input = useRef(null);
  const [reference, setReference] = useState({});
  const [error, setError] = useState('');
  const busy = stage === 'analysing';

  const add = files => {
    const accepted = [...files].filter(f => f.type.startsWith('image/'));
    if (accepted.length !== files.length) setError('Use image files (PNG, JPG, WEBP, or GIF).');
    else setError('');
    setImages(old => [...old, ...accepted.map(file => ({ file, url: URL.createObjectURL(file), id: crypto.randomUUID() }))]);
  };

  const reconstruct = async () => {
    if (!images.length) { setError('Add at least one component image to continue.'); return; }
    setError('');
    setStage('analysing');
    try {
      const result = await analyzeComponent(images, buildReference(reference));
      setAnalysis(result);
      setStage('extracting');
      setPage('workbench');
    } catch (err) {
      setError(err.message || 'Analysis failed. Please try again.');
      setStage('idle');
    }
  };

  return (
    <>
      <Nav />
      <main className="upload-page">
        <button className="back" onClick={() => setPage('home')}><Icon>arrow_back</Icon> Back to brief</button>
        <header>
          <p className="eyebrow">SYNTHESIS / INPUT</p>
          <h1>Upload component views</h1>
          <p>Provide clear angles for the upcoming reconstruction pipeline.</p>
        </header>
        <section className="upload-grid">
          <div className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); add(e.dataTransfer.files); }}>
            <Icon>add_photo_alternate</Icon>
            <h2>Drop component images here</h2>
            <p>PNG, JPG, WEBP or GIF · multiple views supported</p>
            <button className="secondary" onClick={() => input.current.click()}>SELECT IMAGES</button>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={e => { add(e.target.files); e.target.value = ''; }} />
          </div>
          <aside className="input-panel">
            <span className="cad">CAPTURE GUIDANCE</span>
            <p>Include front, side, and detail views where available.</p>
            <div className="ref-block">
              <span className="cad">KNOWN DIMENSIONS <small className="ref-optional">(OPTIONAL)</small></span>
              <p className="ref-hint">Fill any you know — the AI calibrates the render to them. Leave blank to auto-estimate.</p>
              <div className="ref-grid">
                {REFERENCE_FIELDS.map(({ key, label, unit }) => (
                  <label key={key} className="ref-field">
                    <span>{label}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="—"
                      value={reference[key] ?? ''}
                      onChange={e => setReference(prev => ({ ...prev, [key]: e.target.value }))}
                      aria-label={label}
                    />
                    <small>{unit}</small>
                  </label>
                ))}
              </div>
            </div>
          </aside>
        </section>
        {error && <p className="error" role="alert">{error}</p>}
        {busy && <ProgressStepper index={1} />}
        <section className="preview-area">
          <div>
            <p className="eyebrow">SELECTED VIEWS / {images.length}</p>
            {images.length
              ? <div className="previews">{images.map(image => (
                <figure key={image.id}>
                  <img src={image.url} alt={image.file.name} />
                  <button aria-label={`Remove ${image.file.name}`} onClick={() => setImages(items => items.filter(item => item.id !== image.id))}><Icon>close</Icon></button>
                  <figcaption>{image.file.name}</figcaption>
                </figure>
              ))}</div>
              : <p className="empty">No component images selected yet.</p>}
          </div>
          <div className="upload-actions">
            <button className="secondary" onClick={() => input.current.click()}>ADD IMAGES</button>
            <button className="primary" disabled={busy} onClick={reconstruct}>
              {busy ? 'ANALYZING COMPONENT…' : 'CREATE 3D MODEL'} <Icon>precision_manufacturing</Icon>
            </button>
          </div>
        </section>
      </main>
    </>
  );
}

const PARAM_DEFINITIONS = [
  { key: 'outerDiameter', label: 'Outer Ø', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'innerDiameter', label: 'Inner Ø (bore)', unit: 'mm', min: 0, step: 0.5, isDim: true },
  { key: 'height', label: 'Height / Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'width', label: 'Width', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'length', label: 'Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'thickness', label: 'Thickness / Width', unit: 'mm', min: 0.5, step: 0.5, isDim: true },
  { key: 'teeth', label: 'Teeth', unit: 'count', min: 6, max: 120, step: 1, isDim: false, isInteger: true },
  { key: 'module', label: 'Module', unit: 'mm', min: 0.2, max: 20, step: 0.1, isDim: false },
  { key: 'helixAngle', label: 'Helix Angle', unit: 'deg', min: 0, max: 45, step: 1, isDim: false },
];

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

  const availableParams = PARAM_DEFINITIONS.filter(def => {
    const val = def.isDim ? analysis.dimensions?.[def.key] : analysis[def.key];
    return typeof val === 'number' && isFinite(val) && (def.key === 'innerDiameter' || def.key === 'helixAngle' ? val >= 0 : val > 0);
  });

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
      </div>
    </div>
  );
}

function Workbench() {
  const { setPage, images, analysis, stage, setStage } = useApp();
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('chat');
  const [scenarioParams, setScenarioParams] = useState({});
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(false);
  const [stress, setStress] = useState(false);
  const [dims, setDims] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const historyRef = useRef([]);
  const thread = useRef(null);

  useEffect(() => thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' }), [messages, thinking]);

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

  // Reset scenario when a new analysis is loaded
  useEffect(() => {
    setScenarioParams({});
  }, [analysis]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || thinking) return;
    const userMsg = text.trim();
    setMessages(m => [...m, { role: 'user', text: userMsg }]);
    setText('');
    setThinking(true);
    try {
      const reply = await sendChatMessage(userMsg, analysis, historyRef.current);
      setMessages(m => [...m, { role: 'ai', text: reply }]);
      historyRef.current = [...historyRef.current, { role: 'user', text: userMsg }, { role: 'model', text: reply }];
    } catch (err) {
      setMessages(m => [...m, { role: 'ai', text: `[ENGINEER OFFLINE] ${err.message}`, error: true }]);
    }
    setThinking(false);
  };

  const ready = stage === 'ready' && analysis;
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

  return (
    <>
      <Nav />
      <main className={`workbench ${open ? 'chat-open' : ''}`}>
        <section className="viewport">
          <div className="cad viewport-status" aria-live="polite">
            {ready
              ? <>● {label}{conf != null ? ` · CONFIDENCE ${conf}%` : ''}<br /><span>AI RECONSTRUCTED FROM {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED{modifiedCount > 0 ? ' · WHAT-IF SCENARIO ACTIVE' : ''}</span></>
              : <>● {label || 'NO ANALYSIS'} · {analysis ? stage.toUpperCase() : 'AWAITING SYNTHESIS'}<br /><span>AI GENERATED VIEW · {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED</span></>}
          </div>
          {!analysis ? (
            <div className="viewport-hint">
              <Icon>view_in_ar</Icon>
              <p>No component analysis yet.<br />Run synthesis from the upload page to generate a 3D model.</p>
            </div>
          ) : !ready ? (
            <div className="viewport-hint">
              <Icon>precision_manufacturing</Icon>
              <p>Generating reconstruction…</p>
              <ProgressStepper index={stageIndex} />
            </div>
          ) : <div className={`model ${wire ? 'wire' : ''}`}>
            <ReconstructedViewport analysis={activeReconstructionAnalysis} wire={wire} grid={grid} stress={stress} autoRotate={autoRotate} resetKey={resetKey} />
          </div>}
          {ready && dims && (
            <div className="dims-overlay" aria-label="Component dimensions">
              {dimensionList(activeReconstructionAnalysis).map(d => (
                <div className="dims-row" key={d.label}><span className="dims-label">{d.label}</span><span className="dims-value">{d.value}</span></div>
              ))}
            </div>
          )}
          <div className="view-controls">
            <button
              aria-label="Toggle What-If Simulator"
              title="Engineering What-If Simulator"
              className={activeTab === 'whatif' && open ? 'active' : ''}
              disabled={!ready}
              onClick={() => {
                setOpen(true);
                setActiveTab(t => t === 'whatif' ? 'chat' : 'whatif');
              }}
            >
              <Icon>tune</Icon>
            </button>
            <button aria-label="Toggle automatic rotation" title="Auto-rotate" className={autoRotate ? 'active' : ''} disabled={!ready} onClick={() => setAutoRotate(value => !value)}><Icon>360</Icon></button>
            <button aria-label="Toggle wireframe" title="Wireframe" className={wire ? 'active' : ''} disabled={!ready} onClick={() => setWire(value => !value)}><Icon>grid_on</Icon></button>
            <button aria-label="Toggle FEA stress heatmap" title="Stress Heatmap" className={stress ? 'active' : ''} disabled={!ready} onClick={() => setStress(s => !s)}><Icon>local_fire_department</Icon></button>
            <button aria-label="Toggle grid" title="Grid" className={grid ? 'active' : ''} disabled={!ready} onClick={() => setGrid(value => !value)}><Icon>grid_3x3</Icon></button>
            <button aria-label="Toggle dimensions" title="Dimensions" className={dims ? 'active' : ''} disabled={!ready} onClick={() => setDims(d => !d)}><Icon>straighten</Icon></button>
            <button aria-label="Reset viewport" title="Reset view" disabled={!ready} onClick={() => setResetKey(value => value + 1)}><Icon>restart_alt</Icon></button>
          </div>
          <div className="viewport-empty"><Icon>view_in_ar</Icon><span>{ready ? 'DRAG TO ROTATE · SCROLL TO ZOOM · RIGHT-DRAG TO PAN' : 'RE:FORGE RENDERER'}</span></div>
        </section>
        <aside className={`chat ${open ? '' : 'closed'}`}>
          <button className="door" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? 'CLOSE ENGINEER' : 'OPEN ENGINEER'} <Icon>{open ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left'}</Icon>
          </button>
          {open && <>
            <header className="chat-head">
              <div>
                <h2><Icon>{activeTab === 'chat' ? 'smart_toy' : 'tune'}</Icon> {activeTab === 'chat' ? 'RE:FORGE ENGINEER' : 'WHAT-IF SIMULATOR'}</h2>
                <span>{ready ? `COMPONENT CONTEXT · ${label}${conf != null ? ` · ${conf}% CONF` : ''}` : 'AWAITING COMPONENT ANALYSIS'}</span>
              </div>
            </header>
            <div className="panel-tabs" role="tablist" aria-label="Workbench tools">
              <button
                role="tab"
                aria-selected={activeTab === 'chat'}
                className={`panel-tab ${activeTab === 'chat' ? 'active' : ''}`}
                onClick={() => setActiveTab('chat')}
              >
                <Icon>smart_toy</Icon> ENGINEER CHAT
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'whatif'}
                className={`panel-tab ${activeTab === 'whatif' ? 'active' : ''}`}
                onClick={() => setActiveTab('whatif')}
              >
                <Icon>tune</Icon> WHAT-IF {modifiedCount > 0 && <span className="tab-badge">{modifiedCount}</span>}
              </button>
            </div>

            {activeTab === 'chat' ? (
              <>
                <div className="thread" ref={thread}>
                  {!messages.length && (
                    <div className="ai-message"><Icon>smart_toy</Icon><p>I'm ready to analyse the reconstructed component. Ask about dimensions, material, or manufacturing constraints.</p></div>
                  )}
                  {messages.map((m, i) => (
                    <div className={`${m.role}-message${m.error ? ' chat-error' : ''}`} key={i}><p>{m.text}</p></div>
                  ))}
                  {thinking && <div className="ai-message thinking"><Icon>smart_toy</Icon><p>Engineer is thinking…</p></div>}
                </div>
                <form className="composer" onSubmit={send}>
                  <label className="sr-only" htmlFor="question">Ask ReForge Engineer</label>
                  <span>&gt;_</span>
                  <input id="question" value={text} onChange={e => setText(e.target.value)} placeholder="Ask ReForge Engineer…" />
                  <button aria-label="Send message" disabled={!text.trim() || thinking}><Icon>send</Icon></button>
                </form>
              </>
            ) : (
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
              />
            )}
          </>}
        </aside>
        {!open && <button className="reopen" onClick={() => setOpen(true)} aria-label="Open AI Engineer"><Icon>smart_toy</Icon></button>}
      </main>
    </>
  );
}

function App() {
  const [page, setPage] = useState('home');
  const [images, setImages] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [stage, setStage] = useState('idle');

  const updateImages = useCallback((next) => {
    setImages(next);
    setAnalysis(null);
    setStage('idle');
  }, []);

  const value = useMemo(() => ({
    page, setPage,
    images, setImages: updateImages,
    analysis, setAnalysis,
    stage, setStage,
  }), [page, images, analysis, stage, updateImages]);

  return (
    <AppContext.Provider value={value}>
      {page === 'home' ? <Landing /> : page === 'upload' ? <Upload /> : <Workbench />}
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
