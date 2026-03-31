from pydantic import BaseModel
from typing import Dict, List, Any, Optional


# ── Request ──────────────────────────────────────────────────────────────────

class AuditRequest(BaseModel):
    dataset: str                          # base64-encoded CSV
    description: str                      # user's plain-English explanation
    target_column: Optional[str] = None
    sensitive_column: Optional[str] = None
    sensitive_column_2: Optional[str] = None


class ChatRequest(BaseModel):
    dataset_description: str
    audit_summary: str                   # compact JSON string of findings
    conversation: List[Dict[str, str]]   # [{"role": "user"|"assistant", "content": "..."}]
    message: str


# ── Per-group stats ──────────────────────────────────────────────────────────

class GroupStats(BaseModel):
    group: str
    count: int
    avg_marks: Optional[float] = None
    pass_count: int
    fail_count: int
    pass_rate: float
    avg_by_subject: Optional[Dict[str, float]] = None


# ── Metric result ────────────────────────────────────────────────────────────

class MetricResult(BaseModel):
    name: str
    key: str
    value: float
    threshold: Optional[float] = None
    threshold_direction: str = "below"
    flagged: bool
    interpretation: str


# ── Subject analysis ─────────────────────────────────────────────────────────

class SubjectAnalysis(BaseModel):
    subject: str
    teacher: Optional[str] = None
    avg_marks: float
    pass_rate: float
    flagged: bool
    bias_note: Optional[str] = None


# ── Main audit response ──────────────────────────────────────────────────────

class AuditResponse(BaseModel):
    bias_score: float
    bias_level: str
    risk_label: str
    bias_detected: bool

    total_rows: int
    total_students: Optional[int] = None
    columns: List[str]
    sensitive_column: Optional[str] = None
    target_column: Optional[str] = None

    metrics: List[MetricResult]
    group_stats: List[GroupStats]
    subject_analysis: Optional[List[SubjectAnalysis]] = None

    summary: str
    key_findings: List[str]
    recommendations: List[str]

    audit_summary_json: str


class ChatResponse(BaseModel):
    reply: str
