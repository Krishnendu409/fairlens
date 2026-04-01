from pydantic import BaseModel
from typing import List, Optional, Dict, Any


class AnalyseRequest(BaseModel):
    prompt: str
    ai_response: str
    dataset: Optional[List[Dict[str, Any]]] = None
    target_column: Optional[str] = None
    prediction_column: Optional[str] = None
    protected_attribute: Optional[str] = None


class BiasCategory(BaseModel):
    name: str
    score: float


class AnalyseResponse(BaseModel):
    bias_score: float
    bias_level: str
    confidence: float
    categories: List[BiasCategory]
    explanation: str
    unbiased_response: str
    flagged_phrases: List[str]
