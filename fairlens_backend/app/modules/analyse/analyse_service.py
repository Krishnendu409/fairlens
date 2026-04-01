"""
analyse_service.py
Core logic for bias analysis.
Called by analyse_route.py — never directly by external requests.
"""

import os
import ssl
import httpx
import pandas as pd
import numpy as np
from dotenv import load_dotenv

from app.schemas.analyse_schema import AnalyseRequest, AnalyseResponse, BiasCategory
from app.helper.general_helper import (
    build_gemini_prompt,
    parse_gemini_response,
    determine_bias_level,
)
from app.modules.analyse.metrics import compute_all_metrics

load_dotenv()

def _build_gemini_url() -> str:
    override = os.getenv("GEMINI_API_URL")
    if override:
        return override
    base = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/models/")
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    base = base.rstrip("/")
    if base.endswith(":generateContent"):
        return base
    return f"{base}/{model}:generateContent"


def _unwrap_ssl_error(exc: Exception) -> ssl.SSLCertVerificationError | None:
    seen = set()
    cur = exc
    while cur and id(cur) not in seen:
        if isinstance(cur, ssl.SSLCertVerificationError):
            return cur
        seen.add(id(cur))
        cur = getattr(cur, "__cause__", None) or getattr(cur, "__context__", None)
    return None


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = _build_gemini_url()


def _validate_dataset_input(request: AnalyseRequest) -> None:
    if request.dataset is None:
        return
    if not request.dataset:
        raise ValueError("dataset cannot be empty when provided.")
    required = [request.target_column, request.prediction_column, request.protected_attribute]
    if any(v is None for v in required):
        raise ValueError("target_column, prediction_column, and protected_attribute are required when dataset is provided.")

    df = pd.DataFrame(request.dataset)
    missing = [c for c in [request.target_column, request.prediction_column, request.protected_attribute] if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")
    if df[request.protected_attribute].dropna().empty:
        raise ValueError("Protected attribute has no non-null values.")
    if df[request.protected_attribute].astype(str).nunique() < 2:
        raise ValueError("Protected attribute must have at least two groups.")
    for col in [request.target_column, request.prediction_column]:
        if df[col].dropna().empty:
            raise ValueError(f"{col} has no non-null values.")
        if not pd.api.types.is_numeric_dtype(df[col]):
            try:
                pd.to_numeric(df[col])
            except Exception:
                raise ValueError(f"{col} must be numeric or coercible to numeric.")


def _build_local_metrics_categories(request: AnalyseRequest) -> list[BiasCategory]:
    if request.dataset is None:
        return []
    df = pd.DataFrame(request.dataset).copy()
    y_true = pd.to_numeric(df[request.target_column], errors="coerce").fillna(0).astype(int).to_numpy()
    y_pred = pd.to_numeric(df[request.prediction_column], errors="coerce").fillna(0).astype(int).to_numpy()
    protected = df[request.protected_attribute].astype(str).to_numpy()
    metrics = compute_all_metrics(y_true=y_true, y_pred=y_pred, protected=protected)
    return [
        BiasCategory(name="Demographic Parity Difference", score=round(metrics["demographic_parity_difference"] * 100, 2)),
        BiasCategory(name="Disparate Impact Ratio", score=round((1 - min(metrics["disparate_impact_ratio"], 1.0)) * 100, 2)),
        BiasCategory(name="TPR Gap", score=round(metrics["tpr_gap"] * 100, 2)),
        BiasCategory(name="FPR Gap", score=round(metrics["fpr_gap"] * 100, 2)),
        BiasCategory(name="Theil Index", score=round(metrics["theil_index"] * 100, 2)),
        BiasCategory(name="Chi-square Significance", score=100.0 if metrics["chi_square"]["is_significant"] else 0.0),
    ]


async def _call_gemini_with_retry(gemini_prompt: str, retries: int = 2) -> dict:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set in environment variables.")
    payload = {
        "contents": [{"parts": [{"text": gemini_prompt}]}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 8192,
        },
    }
    last_exc = None
    for _ in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    GEMINI_URL,
                    params={"key": GEMINI_API_KEY},
                    json=payload,
                )
            if response.status_code != 200:
                raise RuntimeError(f"Gemini API error {response.status_code}: {response.text[:300]}")
            return response.json()
        except Exception as exc:
            last_exc = exc
            continue
    raise last_exc if last_exc else RuntimeError("Gemini call failed")


async def run_analysis(request: AnalyseRequest) -> AnalyseResponse:
    _validate_dataset_input(request)

    gemini_prompt = build_gemini_prompt(request.prompt, request.ai_response)
    local_categories = _build_local_metrics_categories(request)

    try:
        response_data = await _call_gemini_with_retry(gemini_prompt)
    except httpx.TransportError as exc:
        ssl_err = _unwrap_ssl_error(exc)
        if ssl_err:
            raise RuntimeError(
                "Gemini TLS verification failed. Set GEMINI_API_URL or GEMINI_BASE_URL "
                "to a reachable host whose certificate matches."
            ) from ssl_err
        raise

    try:
        raw_text = response_data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response structure: {e}")

    parsed = parse_gemini_response(raw_text)

    categories = local_categories or [
        BiasCategory(name=cat["name"], score=float(cat["score"]))
        for cat in parsed.get("categories", [])
    ]

    bias_score = float(parsed.get("bias_score", 0))
    bias_level = parsed.get("bias_level") or determine_bias_level(bias_score)
    confidence = float(parsed.get("confidence", 80.0))

    return AnalyseResponse(
        bias_score=bias_score,
        bias_level=bias_level,
        confidence=confidence,
        categories=categories,
        explanation=parsed.get("explanation", ""),
        unbiased_response=parsed.get("unbiased_response", ""),
        flagged_phrases=parsed.get("flagged_phrases", []),
    )
