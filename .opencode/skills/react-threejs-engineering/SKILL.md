---
name: react-threejs-engineering
description: Maintain the existing React + Three.js frontend and 3D viewer. Covers React architecture, Three.js scene management, CAD model loading and rendering, GLB/STL preview integration, camera controls, model manipulation, geometry update handling, backend API communication, loading and error states, and performance optimisation.
---

# React Three.js Engineering

## Purpose

Maintain the existing React + Three.js frontend and 3D viewer. Ensure the frontend correctly renders parametric CAD models, handles user interactions, communicates with the backend, and provides a smooth user experience.

## When to use

- When modifying the React frontend (`frontend/src/`).
- When adding or changing 3D visualization features.
- When integrating new geometry types or recipe styles.
- When debugging rendering issues or performance problems.
- When adding new UI components or interactions.

## Project context

The frontend is a single-page React application built with Vite and Three.js. It consists of:

### Main application (`frontend/src/main.jsx`)

**Key components:**
- `App` — Root component with state management
- `Landing` — Landing page
- `Upload` — Image upload and analysis trigger
- `Workbench` — Main 3D workbench with viewport, controls, and panels
- `ReconstructedViewport` — Three.js 3D viewport component
- `GearCanvas` — Standalone gear visualization
- `ManufacturingPanel` — Manufacturing intelligence display
- `MaterialComparisonPanel` — Material comparison display
- `FeatureIdentificationPanel` — Feature identification and selection
- `EngineeringDrawingModal` — 2D engineering drawing viewer
- `WhatIfSimulator` — What-if engineering change simulator
- `EngineeringReportModal` — Engineering report modal

### Utility modules (`frontend/src/lib/`)

**API and data:**
- `api.js` — Backend API client (`analyzeComponent`, `sendChatMessage`, `simulateEngineeringChange`)
- `engineering-context.js` — Engineering context builder
- `machinery-context.js` — Multi-component machinery context

**Geometry and rendering:**
- `geo.js` — Three.js geometry helpers (materials, shapes, extrude, gearShape)
- `recipe.js` — Recipe sanitization and Three.js recipe execution
- `reconstruct.js` — Component-specific 3D model builders
- `features.js` — Feature extraction and normalization

**Export and manufacturing:**
- `exporters.js` — Multi-format export (STEP, STL, DXF, etc.)
- `manufacturing.js` — Manufacturing data client
- `material-comparison.js` — Material comparison client

### Three.js scene management

**Scene setup:**
```javascript
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
```

**Lighting:**
- Ambient light
- Directional light (key light)
- Point lights for highlights

**Grid and helpers:**
- `GridHelper` for reference grid
- `AxesHelper` for coordinate axes

**Camera controls:**
- OrbitControls for rotation, zoom, pan
- Custom pointer controls for model manipulation

### CAD model loading and rendering

**Recipe-based geometry:**
```javascript
import { sanitizeRecipe, executeRecipe } from './lib/recipe.js';

const recipe = sanitizeRecipe(analysis);
const group = executeRecipe(recipe);
scene.add(group);
```

**Component-specific builders:**
```javascript
import { buildSpurGear, buildCylinder, buildFlange, buildBearing, buildBracket, buildGeneric } from './lib/reconstruct.js';

const model = buildModel(analysis);
scene.add(model);
```

**Geometry update handling:**
- `analysisVersion` state triggers re-render
- `resetKey` state triggers viewport reset
- `isDirty` state tracks unsaved changes

### Backend API communication

**API client (`frontend/src/lib/api.js`):**
```javascript
export async function analyzeComponent(images, reference) {
  const payloads = await Promise.all(images.map(({ file }) => fileToPayload(file)));
  const result = await postJson("/api/analyze-component", { images: payloads, reference });
  if (!result || !result.analysis) throw new ApiError("Server returned no analysis.", 502);
  return result.analysis;
}
```

**Error handling:**
- `ApiError` class with `status` property
- Network errors caught and displayed to user
- Loading states managed with `busy` state

### Loading and error states

**Loading states:**
- `busy` state during API calls
- `thinking` state during chat
- `loading` state for manufacturing data

**Error states:**
- `error` state for API errors
- Error messages displayed in UI
- Graceful degradation for optional features

### Performance optimisation

**Rendering optimisation:**
- `requestAnimationFrame` for animation loop
- `ResizeObserver` for responsive canvas
- Geometry disposal on unmount

**State management:**
- Minimal re-renders with `useState` and `useEffect`
- Memoization where appropriate
- Efficient state updates

## Best practices

1. **Use existing components** — Don't recreate existing UI components
2. **Follow existing patterns** — Use established state management and API patterns
3. **Handle loading and error states** — Always show loading indicators and error messages
4. **Optimize rendering** — Use `requestAnimationFrame`, dispose geometries, limit re-renders
5. **Use Three.js correctly** — Import as `import * as THREE from "three"`, use proper scene graph
6. **Maintain recipe consistency** — Keep `sanitizeRecipe` in sync between frontend and backend
7. **Test with real data** — Test with actual component images and analysis results

## Common mistakes to avoid

- **Replacing the existing frontend** — The React + Three.js frontend is the single source of truth
- **Not handling loading states** — Always show loading indicators during API calls
- **Not handling error states** — Always show error messages to users
- **Ignoring performance** — Use proper rendering techniques and state management
- **Breaking recipe consistency** — Keep `sanitizeRecipe` in sync between frontend and backend
- **Not disposing geometries** — Always dispose Three.js geometries on unmount
- **Hardcoding API URLs** — Use relative URLs for API calls

## Validation checklist

- [ ] React app builds and runs correctly
- [ ] Three.js scene renders correctly
- [ ] Camera controls work (orbit, zoom, pan)
- [ ] Recipe-based geometry renders correctly
- [ ] Component-specific builders work correctly
- [ ] API communication works correctly
- [ ] Loading and error states are handled
- [ ] Performance is acceptable (no memory leaks, smooth rendering)
- [ ] Recipe sanitization is consistent with backend
- [ ] Export functionality works correctly