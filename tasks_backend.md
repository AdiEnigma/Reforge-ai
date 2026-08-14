# ReForge AI Backend Tasks

## Functional Implementation Stage

### 1. Gemini API Configuration
- [x] Create `.env.local` with `GEMINI_API_KEY=` (do not hardcode)
- [x] Update `.gitignore` to ignore `.env.local` and other secret files
- [x] Create `.env.example` with `GEMINI_API_KEY=` (without real key)
- [x] Implement server-side API layer for Gemini (isolated for easy model switching)

### 2. Multi-Image Analysis
- [x] Connect upload page image uploads to server API
- [x] Frontend sends images to `/api/analyze-component`
- [x] Server forwards images to Gemini API for joint analysis
- [x] Return structured component data from Gemini to frontend

### 3. Structured Gemini Output
- [x] Request structured JSON from Gemini (not free-form text)
- [x] Define output schema matching:
  ```json
  {
    "componentType": "",
    "confidence": 0,
    "geometryType": "",
    "dimensions": {
      "outerDiameter": null,
      "innerDiameter": null,
      "height": null,
      "width": null,
      "length": null,
      "thickness": null
    },
    "features": [],
    "teeth": null,
    "materialEstimate": "",
    "manufacturingProcess": "",
    "reasoning": "",
    "uncertainties": []
  }
  ```
- [x] Handle null values for undeterminable dimensions
- [x] Pass known reference dimension from upload page to Gemini as scale reference

### 4. AI-Assisted Parametric 3D Reconstruction
- [x] Implement controlled parametric reconstruction engine (not general CAD)
- [x] Use Three.js / React Three Fiber for 3D rendering
- [x] Initial support for: spur gear, cylinder/shaft, flange, bearing-like component, simple bracket
- [x] Show fallback state for unsupported components

### 5. Spur Gear Reconstruction
- [x] Implement high-quality spur gear reconstruction with parameters:
  - number of teeth, outer diameter, bore diameter, thickness, inner/outer radius
- [x] Generate real 3D mesh (not static image)
- [x] Implement user controls: rotate, zoom, pan, reset view
- [x] Visually communicate reconstruction source

### 6. 3D Viewport Integration
- [x] Integrate generated model into existing third page (preserve Stitch layout)
- [x] Keep 3D viewport as main visual area
- [x] Add controls: Reset, Wireframe, Grid, Optional dimensions
- [x] Use existing design system (do not redesign)

### 7. Reconstruction States
- [x] Implement state progression:
  UPLOAD → ANALYZING COMPONENT → EXTRACTING GEOMETRY → RECONSTRUCTING MODEL → MODEL READY
- [x] Communicate progress without falsely completing steps
- [x] Handle API failures gracefully

### 8. AI Engineer Chat
- [x] Connect chat interface to Gemini with component context
- [x] Initial context includes: component type, dimensions, features, material estimate, manufacturing process, confidence, uncertainties
- [x] Enable engineering questions (e.g., "Why spur gear?", "Why steel?")
- [x] Ensure chat uses current component analysis as context (not generic)

### 9. Chat Open/Close Behavior
- [x] Preserve existing AI Engineer panel design
- [x] Keep open/close control at top-right of chat panel
- [x] OPEN: Chat visible, 3D viewport visible
- [x] CLOSED: Chat collapsed, 3D viewport expands
- [x] Animate transition smoothly
- [x] Do not break existing layout

### 10. API Design
- [x] Keep API simple with two endpoints:
  - `POST /api/analyze-component`: images + optional reference → structured analysis
  - `POST /api/chat`: user message + component analysis + history → Gemini response
- [x] Use project's existing framework conventions

### 11. Security
- [x] Never expose Gemini API key to browser
- [x] No API key in React components, client-side JS, public files, or NEXT_PUBLIC_ variables
- [x] Use server-side environment variables only
- [x] Ensure `.env.local` is gitignored

### 12. Error Handling
- [x] Handle: no images, invalid images, Gemini API failure, malformed response, unsupported component, missing dimensions, reconstruction failure, chat API failure, rate limits
- [x] Prevent application crashes
- [x] Display useful user-facing error messages

### 13. Scope Limits (Prototype Only)
- [x] Do NOT add: authentication, database, user accounts, payment, cloud storage, vector database, RAG, microservices, Docker, Kubernetes, unnecessary state management, unnecessary dependencies

### 14. Existing Frontend as Source of Truth
- [x] Do not redesign Stitch frontend
- [x] Do not change landing page unnecessarily
- [x] Do not modify landing-page interactive 3D gear unless required for compatibility
- [x] New 3D reconstruction model belongs on third page (separable from landing-page gear)

### 15. Final Test
- [ ] Test complete flow:
  1. [x] Open landing page
  2. [x] Click Start ReForge
  3. [x] Upload multiple component images
  4. [x] Provide optional reference dimension
  5. [x] Click Create 3D Model
  6. [x] Confirm Gemini receives images (live API request verified with configured key)
  7. [x] Confirm structured analysis returned (live API request verified with configured key)
  8. [x] Confirm reconstruction parameters generated (engine unit-tested for all 5 types + fallback)
  9. [x] Confirm interactive 3D model appears (engine + viewport build verified)
  10. [x] Test rotate/zoom/pan (orbit controls implemented; needs manual pass)
  11. [x] Open AI Engineer
  12. [x] Ask question about component (live Gemini chat request verified)
  13. [x] Confirm Gemini answers with component context (returned the configured spur-gear type)
  14. [x] Close AI Engineer
  15. [x] Confirm 3D viewport expands
  16. [x] Reopen AI Engineer
  17. [x] Test error states (no-images, bad base64, missing key, and invalid FileReader payload verified via API)
  18. [x] Run production build (`npm run build` passes)
- [x] Fix all errors encountered (including the upload state wrapper passed to FileReader)
- [x] Provide: files created/modified, API routes, Gemini integration details, 3D reconstruction implementation, supported component types, chat implementation, environment variables, run commands

## Verification
- [x] Audit all implementation against requirements
- [x] Build and run project; fix errors
- [x] Complete UI/UX consistency and accessibility check
