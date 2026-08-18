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

function ReconstructedViewport({ analysis, wire, grid, autoRotate, resetKey }) {
  const mount = useRef(null);
  const resetViewRef = useRef(null);
  const options = useRef({ wire, grid, autoRotate });
  options.current = { wire, grid, autoRotate };

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
    const view = { radius: 8, theta: 0.55, phi: 1.35 }; const target = new THREE.Vector3();
    const reset = () => { view.radius = 8; view.theta = 0.55; view.phi = 1.35; target.set(0, 0, 0); }; resetViewRef.current = reset;
    let pointerMode = null, lastPoint = null, appliedWire = null;
    const canvas = renderer.domElement; canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab';
    const onDown = event => { canvas.setPointerCapture(event.pointerId); pointerMode = event.button === 2 ? 'pan' : 'rotate'; lastPoint = { x: event.clientX, y: event.clientY }; canvas.style.cursor = 'grabbing'; };
    const onMove = event => { if (!pointerMode || !lastPoint) return; const dx = event.clientX - lastPoint.x, dy = event.clientY - lastPoint.y; lastPoint = { x: event.clientX, y: event.clientY }; if (pointerMode === 'rotate') { view.theta -= dx * .008; view.phi = Math.max(.18, Math.min(Math.PI - .18, view.phi - dy * .008)); } else { target.x -= dx * .006 * view.radius; target.y += dy * .006 * view.radius; } };
    const onUp = () => { pointerMode = null; lastPoint = null; canvas.style.cursor = 'grab'; };
    const onWheel = event => { event.preventDefault(); view.radius = Math.max(2.5, Math.min(20, view.radius * (1 + event.deltaY * .001))); };
    const preventContext = event => event.preventDefault();
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', preventContext);
    const resize = () => { const { width, height } = host.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); }; const observer = new ResizeObserver(resize); observer.observe(host); resize();
    let frame; const animate = () => { frame = requestAnimationFrame(animate); if (options.current.autoRotate) view.theta += .006; gridHelper.visible = options.current.grid; if (appliedWire !== options.current.wire) { appliedWire = options.current.wire; group.traverse(node => { if (node.isMesh) node.material = appliedWire ? wireMaterial : originals.get(node.uuid); }); } const r = view.radius * Math.sin(view.phi); camera.position.set(target.x + r * Math.cos(view.theta), target.y + view.radius * Math.cos(view.phi), target.z + r * Math.sin(view.theta)); camera.lookAt(target); renderer.render(scene, camera); }; animate();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', preventContext); group.traverse(node => { if (node.geometry) node.geometry.dispose(); }); wireMaterial.dispose(); renderer.dispose(); host.replaceChildren(); };
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

function Workbench() {
  const { setPage, images, analysis, stage, setStage } = useApp();
  const [open, setOpen] = useState(true);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(false);
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

  return (
    <>
      <Nav />
      <main className={`workbench ${open ? 'chat-open' : ''}`}>
        <section className="viewport">
          <div className="cad viewport-status" aria-live="polite">
            {ready
              ? <>● {label}{conf != null ? ` · CONFIDENCE ${conf}%` : ''}<br /><span>AI RECONSTRUCTED FROM {images.length} VIEW{images.length === 1 ? '' : 'S'} STAGED</span></>
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
            <ReconstructedViewport analysis={analysis} wire={wire} grid={grid} autoRotate={autoRotate} resetKey={resetKey} />
          </div>}
          {ready && dims && (
            <div className="dims-overlay" aria-label="Component dimensions">
              {dimensionList(analysis).map(d => (
                <div className="dims-row" key={d.label}><span className="dims-label">{d.label}</span><span className="dims-value">{d.value}</span></div>
              ))}
            </div>
          )}
          <div className="view-controls">
            <button aria-label="Toggle automatic rotation" title="Auto-rotate" className={autoRotate ? 'active' : ''} disabled={!ready} onClick={() => setAutoRotate(value => !value)}><Icon>360</Icon></button>
            <button aria-label="Toggle wireframe" title="Wireframe" className={wire ? 'active' : ''} disabled={!ready} onClick={() => setWire(value => !value)}><Icon>grid_on</Icon></button>
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
                <h2><Icon>smart_toy</Icon> RE:FORGE ENGINEER</h2>
                <span>{ready ? `COMPONENT CONTEXT · ${label}${conf != null ? ` · ${conf}% CONF` : ''}` : 'AWAITING COMPONENT ANALYSIS'}</span>
              </div>
            </header>
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
