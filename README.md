# FairLens

FairLens is an AI fairness auditing platform focused on EU AI Act-aligned governance: it analyses model outputs and tabular datasets for potential bias, generates explainable risk findings, and produces compliance-oriented evidence for high-risk AI workflows.

## Architecture

```text
Frontend (React/Vite)
  ├─ Text Bias Analysis UI
  ├─ Dataset Audit + Results UI
  └─ Share/History/PDF utilities
        │
        ▼
Backend (FastAPI)
  ├─ /analyse (text bias analysis)
  ├─ /audit-dataset (dataset fairness audit)
  ├─ /audit-chat (audit follow-up assistant)
  └─ /compliance-records/* (compliance snapshots)
        │
        ▼
Gemini API (analysis + narrative generation)
```

## Quick Start

### 1) Clone

```bash
git clone https://github.com/Krishnendu409/fairlens.git
cd fairlens
```

### 2) Backend setup

```bash
cd fairlens_backend
cp .env.example .env
# set GEMINI_API_KEY in .env
pip install -r requirements.txt
uvicorn main:app --reload
```

Backend runs on `http://localhost:8000`.

### 3) Frontend setup

```bash
cd ../fairlens_frontend
cp .env.example .env
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## Demo

Use the built-in **Sample: COMPAS** and **Sample: Adult Income** buttons on the home page to run instant audits.

## EU AI Act Compliance Engine

FairLens includes a compliance engine that maps audit evidence to EU AI Act-oriented controls and produces structured compliance outputs (including control gaps, ratings, and remaining controls) to support governance workflows, export snapshots, and review traceability.
