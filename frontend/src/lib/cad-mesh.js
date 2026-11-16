import * as THREE from "three";
import { matBody } from "./geo.js";

const TARGET_SIZE = 6;

/**
 * Build a Three.js group from the JSON mesh exported by python-engine.
 * CAD coordinates are Z-up and in millimetres; the group is centred, scaled to
 * roughly TARGET_SIZE units and rotated to the viewer's Y-up convention.
 */
export function buildCadMeshGroup(mesh, { normalize = true } = {}) {
  const group = new THREE.Group();
  if (!mesh || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.triangles)) {
    return group;
  }
  if (mesh.vertices.length < 9 || mesh.triangles.length < 3) return group;

  const positions = Float32Array.from(mesh.vertices);
  const indices = Uint32Array.from(mesh.triangles);

  const bbox = new THREE.Box3().setFromBufferAttribute(
    new THREE.BufferAttribute(positions, 3)
  );
  if (bbox.isEmpty()) return group;
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = normalize ? TARGET_SIZE / maxDim : 1;

  for (let index = 0; index < positions.length; index += 3) {
    positions[index] = (positions[index] - center.x) * scale;
    positions[index + 1] = (positions[index + 1] - center.y) * scale;
    positions[index + 2] = (positions[index + 2] - center.z) * scale;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const body = new THREE.Mesh(geometry, matBody);
  body.userData = { featureId: "feature-solid-1", featureType: "solid" };
  group.add(body);

  if (Array.isArray(mesh.edges) && mesh.edges.length) {
    const linePositions = [];
    for (const edge of mesh.edges) {
      if (!Array.isArray(edge) || edge.length < 6) continue;
      for (let index = 0; index + 5 < edge.length; index += 3) {
        linePositions.push(
          (edge[index] - center.x) * scale,
          (edge[index + 1] - center.y) * scale,
          (edge[index + 2] - center.z) * scale,
          (edge[index + 3] - center.x) * scale,
          (edge[index + 4] - center.y) * scale,
          (edge[index + 5] - center.z) * scale
        );
      }
    }
    if (linePositions.length) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(linePositions, 3)
      );
      const lines = new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: "#ffb77f", transparent: true, opacity: 0.45 })
      );
      lines.userData = { isEdgeOverlay: true };
      group.add(lines);
    }
  }

  group.rotation.x = -Math.PI / 2;
  return group;
}

export async function fetchCadMesh(fileUrl, { signal } = {}) {
  if (!fileUrl) throw new Error("No CAD mesh URL was provided.");
  const response = await fetch(fileUrl, { signal });
  if (!response.ok) throw new Error(`Could not load CAD mesh (${response.status}).`);
  return response.json();
}
