# FairLens 🔍

**FairLens** is an AI bias detection platform that helps you identify and understand bias in AI-generated text and structured datasets. It analyses responses across six key bias dimensions and provides actionable insights including unbiased rewrites and fairness metrics.

---

## ✨ Features

- **Text Analysis Mode** — Paste any AI-generated response and receive a bias score (0–100) across six protected-attribute dimensions, an explanation of root causes, highlighted flagged phrases, and a suggested unbiased rewrite.
- **Dataset Audit Mode** — Upload a CSV file to detect group disparities. Calculates disparate impact, pass rates, and per-group statistics for up to two sensitive columns.
- **Conversational Follow-up** — Ask follow-up questions about dataset audit findings in a chat interface.
- **History Tracking** — Previous text analyses and dataset audits are stored locally for quick reference.
- **PDF Export** — Download a report of any analysis result.
- **Dark / Light Theme** — Toggle between themes from the header.

---

## 🏗️ Architecture

```
fairlens/
├── fairlens_backend/   # Python · FastAPI · Google Gemini
└── fairlens_frontend/  # JavaScript · React · Vite
```

The **backend** exposes a REST API that uses Google Gemini 2.5 Flash for intelligent bias detection and statistical analysis (pandas, scikit-learn, scipy) for dataset auditing.

The **frontend** is a single-page React application that communicates with the backend via Axios and visualises results with Recharts.

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.10+ |
| Node.js | 18+ |
| Google Gemini API key | — |

### 1 · Clone the repository

```bash
git clone https://github.com/Krishnendu409/fairlens.git
cd fairlens
```

### 2 · Start the backend

```bash
cd fairlens_backend
pip install -r requirements.txt
cp .env.example .env          # add your GEMINI_API_KEY
uvicorn main:app --reload
# API running at http://localhost:8000
# Interactive docs at http://localhost:8000/docs
```

### 3 · Start the frontend

```bash
cd fairlens_frontend
npm install
cp .env.example .env          # set VITE_API_URL=http://localhost:8000
npm run dev
# App running at http://localhost:5173
```

---

## 🔌 API Reference

### `GET /`

Health check.

```json
{
  "status": "FairLens API v2.0 is running",
  "modes": ["text-analysis", "dataset-audit"]
}
```

---

### `POST /analyse`

Analyse an AI-generated response for bias.

**Request body**

```json
{
  "prompt": "What jobs are best for women?",
  "ai_response": "Women are naturally better at nurturing roles like nursing or teaching."
}
```

**Response**

```json
{
  "bias_score": 78.5,
  "bias_level": "High",
  "confidence": 85.0,
  "categories": [
    { "name": "Gender",        "score": 90.0 },
    { "name": "Race",          "score": 5.0  },
    { "name": "Age",           "score": 3.0  },
    { "name": "Religion",      "score": 2.0  },
    { "name": "Socioeconomic", "score": 4.0  },
    { "name": "Political",     "score": 1.0  }
  ],
  "explanation": "The response reinforces gender stereotypes by assuming women are inherently suited only for caregiving professions.",
  "unbiased_response": "People of all genders excel in a wide variety of careers based on their individual skills and interests.",
  "flagged_phrases": ["naturally better at nurturing roles"]
}
```

---

### `POST /audit-dataset`

Perform a fairness audit on a CSV dataset.

**Request body**

```json
{
  "dataset": "<base64-encoded CSV string>",
  "description": "Student grade dataset from a university entrance exam.",
  "target_column": "marks",
  "sensitive_column": "gender",
  "sensitive_column_2": "grade"
}
```

> `target_column`, `sensitive_column`, and `sensitive_column_2` are optional; omitting them triggers automatic column detection.

---

### `POST /audit-chat`

Ask a follow-up question about a previous dataset audit.

**Request body**

```json
{
  "dataset_description": "Student grade dataset...",
  "audit_summary": "<summary from /audit-dataset response>",
  "conversation": [
    { "role": "user",      "content": "Which group has the lowest pass rate?" },
    { "role": "assistant", "content": "The female group has a pass rate of 42%." }
  ],
  "message": "What could explain that disparity?"
}
```

---

## 🧩 Bias Dimensions

| Dimension | Examples of detected bias |
|-----------|--------------------------|
| **Gender** | Stereotypical role assumptions, gendered language |
| **Race** | Racial generalisations, exclusionary framing |
| **Age** | Ageist assumptions about competence or behaviour |
| **Religion** | Faith-based generalisations or prejudice |
| **Socioeconomic** | Class-based assumptions, poverty stereotyping |
| **Political** | Partisan framing, ideological bias |

---

## ☁️ Deployment

### Backend — Render

1. Push `fairlens_backend/` to a GitHub repository.
2. On [Render](https://render.com) → **New Web Service** → connect the repo.
3. Set **Build command**: `pip install -r requirements.txt`
4. Set **Start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add environment variable: `GEMINI_API_KEY` = your key.
6. Deploy and copy the service URL for the frontend.

### Frontend — Netlify

1. Push `fairlens_frontend/` to a GitHub repository.
2. On [Netlify](https://netlify.com) → **Add new site** → **Import from Git**.
3. Set **Build command**: `npm run build`
4. Set **Publish directory**: `dist`
5. Add environment variable: `VITE_API_URL` = your Render backend URL.
6. Deploy. The included `netlify.toml` handles SPA routing automatically.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| AI / NLP | Google Gemini 2.5 Flash |
| Backend framework | FastAPI 0.103 |
| Data analysis | pandas, NumPy, scikit-learn, SciPy |
| Frontend framework | React 18 + React Router 6 |
| Build tool | Vite 5 |
| Charts | Recharts |
| HTTP client | Axios |
| PDF generation | jsPDF |

---

## 🤝 Contributing

Contributions are welcome! Please open an issue to discuss your idea before submitting a pull request.

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a pull request.
