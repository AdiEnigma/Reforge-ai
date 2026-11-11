# ReForge AI

ReForge AI is an AI-assisted engineering tool for **MSMEs** (micro, small and medium enterprises) in manufacturing. It lets you upload photos of a mechanical component (gears, shafts, flanges, brackets, bearings) and get an AI-generated parametric **3D model** you can inspect — no CAD expertise or expensive software required. This helps small workshops and fabricators reverse-engineer parts, quote jobs, and communicate designs faster.

## Features

- Upload one or more photos of a component (drag-and-drop or click to select)
- Gemini analyzes the images and returns structured geometry (component type, dimensions, features, material estimate, manufacturing process)
- AI-powered parametric 3D reconstruction (spur gear, cylinder/shaft, flange, bearing, bracket)
- Interactive 3D viewport: rotate, zoom, pan, wireframe, grid, dimensions, reset
- **AI Engineer** chat to ask engineering questions about your component

## Prerequisites

- Node.js 18+
- A [Gemini API key](https://aistudio.google.com/apikey)

## Setup

```bash
# 1. Install backend dependencies
cd backend
npm install

# 2. Configure your Gemini API key
copy .env.example .env.local
# then edit .env.local and set GEMINI_API_KEY=your_key_here

# 3. Install frontend dependencies
cd ../frontend
npm install
```

## Run (development)

In two terminals:

```bash
# Terminal 1 — backend API (http://localhost:8787)
cd backend
npm run server

# Terminal 2 — frontend (http://localhost:5173)
cd frontend
npm run dev
```

Open http://localhost:5173, click **Start ReForge**, upload component photos, optionally enter a known reference dimension, then click **Create 3D Model**.

## Run (production)

```bash
cd frontend
npm run build

cd ../backend
npm run server
```

The backend serves the built frontend at http://localhost:8787.

## Environment variables

| Variable        | Required | Description                          |
| --------------- | -------- | ------------------------------------ |
| `GEMINI_API_KEY`| Yes      | Gemini API key (kept server-side)    |
| `GEMINI_MODEL`  | No       | Gemini model, defaults to `gemini-2.0-flash` |
| `PORT`          | No       | Backend port, defaults to `8787`     |

The API key is never exposed to the browser — it stays in the backend's `.env.local` (gitignored).

## Project structure

```
backend/   Express + Gemini API server (/api/analyze-component, /api/chat, /api/health)
frontend/  React + Vite + Three.js app (landing, upload, 3D reconstruction workbench)
```

## License

Prototype — for demonstration purposes.


---

## Vision Preprocessing Service (Optional)

ReForge AI includes an optional Python-based vision preprocessing service that uses
**SAM 2.1** image segmentation, **OpenCV** geometric feature extraction, and **Depth Anything V2 Small**
depth estimation to provide supplementary visual evidence to the Gemini analysis.

> **Disabled by default.** The existing Gemini-only analysis path works exactly as
> before when `VISION_PIPELINE_ENABLED=false` (the default).

### Prerequisites

- Python >= 3.10
- ~2 GB disk space for model checkpoints (downloaded separately)
- Recommended: Linux or WSL2 with Ubuntu on Windows (for SAM 2 CUDA support; CPU fallback is automatic)

### Quick start

```bash
# 1. Create virtual environment for vision service
cd vision-engine
python -m venv .venv

# Windows (PowerShell)
.venv\Scripts\activate
# Linux / macOS / WSL2
source .venv/bin/activate

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Download model checkpoints (~284 MB)
python scripts/download_models.py

# 4. Start the vision service (loopback only)
uvicorn app:app --host 127.0.0.1 --port 8765
```

### Enable in backend

Add to `backend/.env.local`:
```env
VISION_PIPELINE_ENABLED=true
VISION_SERVICE_URL=http://127.0.0.1:8765
```

### Fail-safe behavior

If the vision service is offline, times out, or returns an error:
- `VISION_FAIL_OPEN=true` (default): analysis continues using Gemini only
- A warning is logged server-side
- The API response `{ analysis }` is unaffected

### Model information

See [MODEL_NOTICES.md](MODEL_NOTICES.md) for upstream URLs, licenses (both Apache-2.0), and checkpoint details.
