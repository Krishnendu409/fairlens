"""
analyse_service.py
Core logic for bias analysis.
Called by analyse_route.py — never directly by external requests.
"""

import os
import httpx
from dotenv import load_dotenv

from app.schemas.analyse_schema import AnalyseRequest, AnalyseResponse, BiasCategory
from app.helper.general_helper import (
    build_gemini_prompt,
    parse_gemini_response,
    determine_bias_level,
)

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)


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

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json=payload,
        )

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
