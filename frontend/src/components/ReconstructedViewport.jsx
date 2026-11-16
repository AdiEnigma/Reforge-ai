/**
 * ReconstructedViewport.jsx
 * Shared Three.js viewport used by the Workbench and the floating PiP window.
 * Renders the instant approximate preview (JS recipe) or, when available, the
 * parametric CAD mesh returned by python-engine.
 */

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { buildModel } from '../lib/reconstruct.js';
import { buildCadMeshGroup } from '../lib/cad-mesh.js';

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

      vec3 jetHeatmap(float val) {
        float v = clamp(val, 0.0, 1.0);
        return clamp(vec3(
          1.5 - abs(v * 4.0 - 3.0),
          1.5 - abs(v * 4.0 - 2.0),
          1.5 - abs(v * 4.0 - 1.0)
        ), 0.0, 1.0);
      }

      void main() {
        float dist = length(vPosition.xy);
        float curvature = length(cross(dFdx(vNormal), dFdy(vNormal))) * 5.0;
        float stressFactor = clamp(sin(dist * 1.5) * 0.5 + 0.5 + curvature * 0.3, 0.0, 1.0);
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.8));
        float diff = max(dot(normalize(vNormal), lightDir), 0.25);
        vec3 heatColor = jetHeatmap(stressFactor);
        gl_FragColor = vec4(heatColor * diff, 1.0);
      }
    `,
  });
}

export function ReconstructedViewport({
  analysis,
  cadMesh = null,
  useCadMesh = false,
  wire,
  grid,
  stress,
  autoRotate,
  resetKey,
  selectedFeatureId,
  hoveredFeatureId,
}) {
  const mount = useRef(null);
  const resetViewRef = useRef(null);
  const options = useRef({ wire, grid, stress, autoRotate, selectedFeatureId, hoveredFeatureId });
  options.current = { wire, grid, stress, autoRotate, selectedFeatureId, hoveredFeatureId };

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const { group } =
      useCadMesh && cadMesh ? { group: buildCadMeshGroup(cadMesh) } : buildModel(analysis);
    scene.add(group);
    scene.add(new THREE.AmbientLight('#7a4a38', 0.6));
    const key = new THREE.DirectionalLight('#ffb77f', 0.8);
    key.position.set(6, 8, 10);
    scene.add(key);
    const fill = new THREE.PointLight('#b76308', 1.0, 25);
    fill.position.set(-5, -4, 6);
    scene.add(fill);
    const gridHelper = new THREE.GridHelper(10, 12, '#544337', '#3d332c');
    gridHelper.position.z = -1.2;
    gridHelper.visible = false;
    scene.add(gridHelper);

    const originals = new Map();
    group.traverse((node) => {
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

    const stressMaterial = createStressMaterial();
    const view = { radius: 8, theta: 0.55, phi: 1.35 };
    const target = new THREE.Vector3();
    const reset = () => {
      view.radius = 8;
      view.theta = 0.55;
      view.phi = 1.35;
      target.set(0, 0, 0);
    };
    resetViewRef.current = reset;
    let pointerMode = null;
    let lastPoint = null;
    let appliedKey = null;
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    const onDown = (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointerMode = event.button === 2 ? 'pan' : 'rotate';
      lastPoint = { x: event.clientX, y: event.clientY };
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (event) => {
      if (!pointerMode || !lastPoint) return;
      const dx = event.clientX - lastPoint.x;
      const dy = event.clientY - lastPoint.y;
      lastPoint = { x: event.clientX, y: event.clientY };
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
    const onWheel = (event) => {
      event.preventDefault();
      view.radius = Math.max(2.5, Math.min(20, view.radius * (1 + event.deltaY * 0.001)));
    };
    const preventContext = (event) => event.preventDefault();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', preventContext);
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (options.current.autoRotate) view.theta += 0.006;
      gridHelper.visible = options.current.grid;

      const activeFeatureId =
        options.current.selectedFeatureId || options.current.hoveredFeatureId || null;
      const isSelected = Boolean(options.current.selectedFeatureId);
      const materialKey = `${options.current.wire ? 'w' : ''}${options.current.stress ? 's' : ''}|${activeFeatureId ?? ''}`;

      if (materialKey !== appliedKey) {
        appliedKey = materialKey;

        group.traverse((node) => {
          if (!node.isMesh) return;

          if (node.userData?.isHighlightOnly) {
            node.visible = Boolean(activeFeatureId && node.userData.featureId === activeFeatureId);
          } else if (options.current.wire) {
            node.material = wireMaterial;
          } else if (
            activeFeatureId &&
            (node.userData?.featureId === activeFeatureId ||
              node.parent?.userData?.featureId === activeFeatureId)
          ) {
            node.material = isSelected ? selectHighlightMat : hoverHighlightMat;
          } else if (options.current.stress) {
            node.material = stressMaterial;
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
      group.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
      });
      wireMaterial.dispose();
      selectHighlightMat.dispose();
      hoverHighlightMat.dispose();
      stressMaterial.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [analysis, cadMesh, useCadMesh]);

  useEffect(() => {
    resetViewRef.current?.();
  }, [resetKey]);
  return <div className="model-canvas" ref={mount} aria-label="Interactive reconstructed 3D model" />;
}

export default ReconstructedViewport;
