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