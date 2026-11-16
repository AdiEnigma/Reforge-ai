import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { buildCadMeshGroup } from './cad-mesh.js';

function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildExportGroup(mesh) {
  if (!mesh?.vertices?.length || !mesh?.triangles?.length) {
    throw new Error('A generated CAD mesh is required for mesh export.');
  }
  return buildCadMeshGroup(mesh, { normalize: false });
}

function disposeGroup(group) {
  group.traverse((node) => {
    node.geometry?.dispose();
    if (Array.isArray(node.material)) {
      node.material.forEach((material) => material.dispose());
    } else {
      node.material?.dispose();
    }
  });
}

function base64ArrayBuffer(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function triangleNormal(pos, ia, ib, ic) {
  const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
  const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
  const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return [
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ];
}

export function exportOBJ(mesh, filename = 'component.obj') {
  return new Promise((resolve, reject) => {
    try {
      const group = buildExportGroup(mesh);
      const scene = new THREE.Scene();
      scene.add(group);
      const content = new OBJExporter().parse(scene);
      downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
      disposeGroup(group);
      resolve({ content, filename });
    } catch (error) {
      reject(error);
    }
  });
}

export function exportSTL(mesh, filename = 'component.stl') {
  return new Promise((resolve, reject) => {
    try {
      const group = buildExportGroup(mesh);
      let content = 'solid component\n';
      group.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        const pos = node.geometry.attributes.position.array;
        const idx = node.geometry.index;
        const count = idx ? idx.count : pos.length / 3;
        for (let i = 0; i < count; i += 3) {
          const a = idx ? idx.getX(i) : i;
          const b = idx ? idx.getX(i + 1) : i + 1;
          const c = idx ? idx.getX(i + 2) : i + 2;
          const [nx, ny, nz] = triangleNormal(pos, a, b, c);
          content += `  facet normal ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}\n`;
          content += `    outer loop\n`;
          for (const v of [a, b, c]) {
            const o = v * 3;
            content += `      vertex ${pos[o].toFixed(6)} ${pos[o + 1].toFixed(6)} ${pos[o + 2].toFixed(6)}\n`;
          }
          content += `    endloop\n`;
          content += `  endfacet\n`;
        }
      });
      content += 'endsolid component\n';
      downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
      disposeGroup(group);
      resolve({ content, filename });
    } catch (error) {
      reject(error);
    }
  });
}

export function exportGLTF(mesh, filename = 'component.glb', binary = true) {
  return new Promise((resolve, reject) => {
    try {
      const group = buildExportGroup(mesh);
      const allPositions = [];
      const allIndices = [];
      let indexOffset = 0;
      group.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        const pos = node.geometry.attributes.position;
        const idx = node.geometry.index;
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i < count; i += 3) {
          const a = idx ? idx.getX(i) + indexOffset : i + indexOffset;
          const b = idx ? idx.getX(i + 1) + indexOffset : i + 1 + indexOffset;
          const c = idx ? idx.getX(i + 2) + indexOffset : i + 2 + indexOffset;
          allIndices.push(a, b, c);
        }
        for (let i = 0; i < pos.count; i++) {
          const o = i * 3;
          allPositions.push(pos.array[o], pos.array[o + 1], pos.array[o + 2]);
        }
        indexOffset += pos.count;
      });

      const positions = new Float32Array(allPositions);
      const indices = new Uint32Array(allIndices);
      const combined = new Uint8Array(positions.byteLength + indices.byteLength);
      combined.set(new Uint8Array(positions.buffer), 0);
      combined.set(new Uint8Array(indices.buffer), positions.byteLength);

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < allPositions.length; i += 3) {
        minX = Math.min(minX, allPositions[i]);
        minY = Math.min(minY, allPositions[i + 1]);
        minZ = Math.min(minZ, allPositions[i + 2]);
        maxX = Math.max(maxX, allPositions[i]);
        maxY = Math.max(maxY, allPositions[i + 1]);
        maxZ = Math.max(maxZ, allPositions[i + 2]);
      }

      const gltf = {
        asset: { version: '2.0', generator: 'ReForge AI' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{
          primitives: [{
            attributes: { POSITION: 0 },
            indices: 1,
            mode: 4,
            material: 0,
          }],
        }],
        materials: [{ pbrMetallicRoughness: {} }],
        accessors: [
          {
            bufferView: 0,
            byteOffset: 0,
            componentType: 5126,
            count: positions.length / 3,
            type: 'VEC3',
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
          },
          {
            bufferView: 1,
            byteOffset: 0,
            componentType: 5125,
            count: indices.length,
            type: 'SCALAR',
          },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
          { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
        ],
        buffers: [{
          byteLength: combined.length,
          uri: `data:application/octet-stream;base64,${base64ArrayBuffer(combined)}`,
        }],
      };

      const json = JSON.stringify(gltf, null, 2);
      const content = binary ? combined : json;
      const mime = binary ? 'model/gltf-binary' : 'model/gltf+json';
      downloadBlob(new Blob([content], { type: mime }), filename);
      disposeGroup(group);
      resolve({ content: json, filename });
    } catch (error) {
      reject(error);
    }
  });
}
