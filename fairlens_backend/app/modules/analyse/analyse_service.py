"""
analyse_service.py
Core logic for bias analysis.
Called by analyse_route.py — never directly by external requests.
"""

import os
import ssl
import httpx
from dotenv import load_dotenv

from app.schemas.analyse_schema import AnalyseRequest, AnalyseResponse, BiasCategory
from app.helper.general_helper import (
    build_gemini_prompt,
    parse_gemini_response,
    determine_bias_level,
)

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


async def run_analysis(request: AnalyseRequest) -> AnalyseResponse:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set in environment variables.")

    gemini_prompt = build_gemini_prompt(request.prompt, request.ai_response)

    payload = {
        "contents": [{"parts": [{"text": gemini_prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                GEMINI_URL,
                params={"key": GEMINI_API_KEY},
                json=payload,
            )
    except httpx.TransportError as exc:
        ssl_err = _unwrap_ssl_error(exc)
        if ssl_err:
            raise RuntimeError(
                "Gemini TLS verification failed. Set GEMINI_API_URL or GEMINI_BASE_URL "
                "to a reachable host whose certificate matches."
            ) from ssl_err
        raise

    if response.status_code != 200:
        raise RuntimeError(
            f"Gemini API error {response.status_code}: {response.text[:300]}"
        )

    response_data = response.json()

    try:
        raw_text = response_data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response structure: {e}")

    parsed = parse_gemini_response(raw_text)

    categories = [
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
