# ReForge AI frontend tasks

## Discovery

- [x] Inspect the supplied Stitch HTML screens, design guidance, and standalone gear implementation.
- [x] Record the current constraint: the `frontend` directory contains exported HTML/design assets, not an executable React project.
- [x] Create a small React/Vite implementation that faithfully translates the supplied Stitch screens into a runnable prototype.

## Landing page

- [x] Preserve the Stitch landing-page hierarchy, navigation, colours, typography, technical grid, and hero content.
- [x] Extract only the Three.js gear scene into a responsive, non-intercepting hero background component.
- [x] Connect landing navigation and primary calls to action.

## Upload page

- [x] Implement click-to-select and drag-and-drop image selection.
- [x] Validate image files, show previews, support removal and incremental additions.
- [x] Retain selected images in shared frontend state through navigation.
- [x] Add empty, validation, and reconstruction-loading states.

## Reconstruction workbench

- [x] Implement the Stitch-inspired 3D viewport placeholder and functional viewport controls.
- [x] Build the AI Engineer conversation UI with local-only messages, empty state, thinking state, and auto-scroll.
- [x] Add a smooth, accessible open/close control for the AI Engineer panel.
- [x] Surface an explicit future-integration boundary for Gemini and the real renderer.

## Verification

- [x] Audit buttons, controls, navigation, keyboard labels, and responsive behaviour.
- [x] Build and run the project; fix introduced errors.
- [x] Complete a UI/UX consistency and accessibility pass without changing the Stitch visual direction.

## Follow-up UI refinement

- [x] Remove Synthesis and Analytics from the shared header.
- [x] Keep the animated 3D gear exclusive to the landing hero; reserve the workbench viewport for future renderer output.
- [x] Restore the separate AI-parametric reconstruction viewer in the workbench with rotate, zoom, pan, wireframe, grid, dimensions, and reset controls.
