import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as exporters from './exporters.js';

const mockMesh = {
  vertices: [
    0, 0, 0,
    10, 0, 0,
    10, 10, 0,
    0, 10, 0,
    0, 0, 5,
    10, 0, 5,
    10, 10, 5,
    0, 10, 5,
  ],
  triangles: [
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ],
};

describe('Real CAD Exporters', () => {
  it('exports OBJ', async () => {
    const result = await exporters.exportOBJ(mockMesh, 'test.obj');
    assert.ok(typeof result.content === 'string');
    assert.ok(result.content.includes('o '));
    assert.ok(result.filename.endsWith('.obj'));
  });

  it('exports GLTF/GLB', async () => {
    const glb = await exporters.exportGLTF(mockMesh, 'test.glb', true);
    assert.ok(glb.filename.endsWith('.glb'));

    const gltf = await exporters.exportGLTF(mockMesh, 'test.gltf', false);
    assert.ok(gltf.filename.endsWith('.gltf'));
    assert.ok(typeof gltf.content === 'string');
    assert.ok(gltf.content.includes('"asset"'));
    assert.ok(gltf.content.includes('"generator": "ReForge AI"'));
  });

  it('exports STL', async () => {
    const result = await exporters.exportSTL(mockMesh, 'test.stl');
    assert.ok(typeof result.content === 'string');
    assert.ok(result.content.includes('solid component'));
    assert.ok(result.content.includes('endsolid component'));
    assert.ok(result.filename.endsWith('.stl'));
  });

  it('throws when mesh has no vertices or triangles', async () => {
    await assert.rejects(() => exporters.exportOBJ({ vertices: [], triangles: [] }), Error);
    await assert.rejects(() => exporters.exportSTL({ vertices: [], triangles: [] }), Error);
    await assert.rejects(() => exporters.exportGLTF({ vertices: [], triangles: [] }), Error);
  });
});
