from pydantic import BaseModel
from typing import List


class AnalyseRequest(BaseModel):
    prompt: str
    ai_response: str


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
