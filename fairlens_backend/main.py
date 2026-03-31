"""
main.py
FairLens Backend — FastAPI entry point.
Run locally: uvicorn main:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.modules.analyse.analyse_route import router as analyse_router
from app.modules.audit.audit_route import router as audit_router

app = FastAPI(
    title="FairLens API",
    description="AI bias detection backend — text analysis + dataset fairness auditing.",
    version="2.0.0",
)

# ─── CORS ────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ─────────────────────────────────────────────────────────────────
app.include_router(analyse_router)
app.include_router(audit_router)

# ─── Health check ────────────────────────────────────────────────────────────
@app.get("/", tags=["Health"])
async def root():
    return {"status": "FairLens API v2.0 is running", "modes": ["text-analysis", "dataset-audit"]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
