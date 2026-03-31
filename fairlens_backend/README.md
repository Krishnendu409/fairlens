# FairLens Backend

FastAPI backend for AI bias detection. Calls Google Gemini 1.5 Pro.

## Local Development

```bash
pip install -r requirements.txt
cp .env.example .env        # add your GEMINI_API_KEY
# Optional if you route through a proxy with a different TLS host:
# GEMINI_BASE_URL=https://your-proxy.example.com/v1beta/models
# GEMINI_API_URL=https://your-proxy.example.com/v1beta/models/gemini-2.5-flash:generateContent
uvicorn main:app --reload
```

API docs: http://localhost:8000/docs

## Render Deployment

1. Push this folder to a GitHub repo (e.g. `fairlens-backend`)
2. On Render → New Web Service → connect that repo
3. **Build command:** `pip install -r requirements.txt`
4. **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Under **Environment Variables** add: `GEMINI_API_KEY` = your key
6. Deploy — copy the Render URL for the frontend `.env`

## Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyse` | Analyse prompt+response for bias |
| GET | `/` | Health check |

### POST /analyse — Request Body
```json
{
  "prompt": "What jobs are best for women?",
  "ai_response": "Women are naturally better at nurturing roles like nursing or teaching."
}
```

### POST /analyse — Response
```json
{
  "bias_score": 78.5,
  "bias_level": "High",
  "categories": [
    {"name": "Gender", "score": 90.0},
    {"name": "Race", "score": 5.0},
    ...
  ],
  "explanation": "The response reinforces gender stereotypes...",
  "unbiased_response": "People of all genders excel in a wide variety of careers...",
  "flagged_phrases": ["naturally better at nurturing roles"]
}
```
