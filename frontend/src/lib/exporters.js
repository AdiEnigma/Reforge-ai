import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildCadMeshGroup } from './cad-mesh.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildExportScene(mesh) {
  if (!mesh?.vertices?.length || !mesh?.triangles?.length) {
    throw new Error('A generated CAD mesh is required for mesh export.');
  }
  // Keep the CAD mesh at its original millimetre scale. The viewer's 6-unit
  // normalization is intentionally not applied to downloaded geometry.
  const group = buildCadMeshGroup(mesh, { normalize: false });
  group.traverse((node) => {
    if (node.isMesh) {
      node.material = new THREE.MeshStandardMaterial({
        color: '#b87952',
        metalness: 0.25,
        roughness: 0.65,
      });
    }
  });
  const scene = new THREE.Scene();
  scene.add(group);
  return { scene, group };
}

export function exportOBJ(mesh, filename = 'component.obj') {
  const { scene, group } = buildExportScene(mesh);
  try {
    const content = new OBJExporter().parse(scene);
    downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
  } finally {
    group.traverse((node) => {
      node.geometry?.dispose();
      if (Array.isArray(node.material)) node.material.forEach((material) => material.dispose());
      else node.material?.dispose();
    });
  }
}

export function exportGLTF(mesh, filename = 'component.glb', binary = true) {
  const { scene, group } = buildExportScene(mesh);
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (result) => {
        try {
          const blob = binary
            ? new Blob([result], { type: 'model/gltf-binary' })
            : new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' });
          downloadBlob(blob, filename);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          group.traverse((node) => {
            node.geometry?.dispose();
            if (Array.isArray(node.material)) node.material.forEach((material) => material.dispose());
            else node.material?.dispose();
          });
        }
      },
      (error) => {
        group.traverse((node) => {
          node.geometry?.dispose();
          if (Array.isArray(node.material)) node.material.forEach((material) => material.dispose());
          else node.material?.dispose();
        });
        reject(error);
      },
      { binary }
    );
  });
}
