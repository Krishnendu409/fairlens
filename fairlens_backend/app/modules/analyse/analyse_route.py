"""
analyse_route.py
Defines the /analyse endpoint.
Routes call services — no business logic lives here.
"""

from fastapi import APIRouter, HTTPException
from app.schemas.analyse_schema import AnalyseRequest, AnalyseResponse
from app.modules.analyse.analyse_service import run_analysis

router = APIRouter(prefix="/analyse", tags=["Analyse"])


@router.post("", response_model=AnalyseResponse)
async def analyse_bias(request: AnalyseRequest):
    """
    POST /analyse
    Body: { "prompt": "...", "ai_response": "..." }
    Returns full bias analysis from Gemini 1.5 Pro.
    """
    try:
        result = await run_analysis(request)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")
