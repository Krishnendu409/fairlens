from pydantic import BaseModel, Field
from typing import Dict, List, Any, Optional

# ── Validation roles (fixed) ───────────────────────────────────────────────────
VALIDATION_ROLES = [
    "System Owner / Deployer",
    "Compliance Officer",
    "Data Protection Officer (DPO)",
    "Technical Lead / Model Developer",
]
TECHNICAL_LEAD_ROLE = "Technical Lead / Model Developer"


# ── Request ──────────────────────────────────────────────────────────────────

class AuditRequest(BaseModel):
    dataset: str                          # base64-encoded CSV
    description: str                      # user's plain-English explanation
    target_column: Optional[str] = None
    sensitive_column: Optional[str] = None
    sensitive_column_2: Optional[str] = None
    prediction_column: Optional[str] = None


class ChatRequest(BaseModel):
    dataset_description: str
    audit_summary: str                   # compact JSON string of findings
    conversation: List[Dict[str, str]]   # [{"role": "user"|"assistant", "content": "..."}]
    message: str


# ── Confusion matrix ─────────────────────────────────────────────────────────

class ConfusionMatrix(BaseModel):
    tp: int
    fp: int
    tn: int
    fn: int
    tpr: Optional[float] = None
    fpr: Optional[float] = None
    acc: Optional[float] = None


# ── Per-group stats ──────────────────────────────────────────────────────────

class GroupStats(BaseModel):
    group: str
    count: int
    avg_value: Optional[float] = None
    avg_by_col: Optional[Dict[str, float]] = None
    pass_count: int
    fail_count: int
    pass_rate: float
    tpr: Optional[float] = None
    fpr: Optional[float] = None
    accuracy: Optional[float] = None
    confusion: Optional[ConfusionMatrix] = None


# ── Metric result ────────────────────────────────────────────────────────────

class MetricResult(BaseModel):
    name: str
    key: str
    value: Optional[float] = None
    threshold: Optional[float] = None
    threshold_direction: str = "below"
    flagged: bool
    interpretation: str = ""


# ── Bias origin ──────────────────────────────────────────────────────────────

class BiasOrigin(BaseModel):
    group: str
    metric: str


# ── Data reliability ─────────────────────────────────────────────────────────

class DataReliability(BaseModel):
    reliability: str
    confidence_score: Optional[float] = None
    warnings: List[str] = []


# ── Statistical test ─────────────────────────────────────────────────────────

class StatisticalTest(BaseModel):
    test: str
    statistic: float
    p_value: float
    is_significant: bool
    interpretation: str
    cramers_v: Optional[float] = None
    effect_size: Optional[str] = None


# ── Mitigation ───────────────────────────────────────────────────────────────

class MitigationMethodResult(BaseModel):
    method: str
    bias_score: float
    accuracy: Optional[float] = None
    tpr_gap: Optional[float] = None
    fpr_gap: Optional[float] = None
    dpd: float
    improvement: float
    final_score: float
    description: str = ""


class MitigationSummary(BaseModel):
    before_bias_score: float
    results: List[MitigationMethodResult]
    best_method: str
    best_reason: str
    bias_before: float
    bias_after: float
    accuracy_after: Optional[float] = None
    trade_off_summary: str = ""


# ── Main audit response ──────────────────────────────────────────────────────

class AuditResponse(BaseModel):
    bias_score: float
    bias_level: str
    risk_label: str
    bias_detected: bool

    total_rows: int
    columns: List[str]
    sensitive_column: Optional[str] = None
    target_column: Optional[str] = None
    prediction_column: Optional[str] = None
    has_predictions: bool = False

    metrics: List[MetricResult]
    group_stats: List[GroupStats]

    statistical_test: Optional[StatisticalTest] = None
    bias_origin: Optional[BiasOrigin] = None
    root_causes: List[str] = []
    mitigation: Optional[MitigationSummary] = None
    reliability: Optional[DataReliability] = None

    summary: str
    key_findings: List[str]
    recommendations: List[str]

    audit_summary_json: str
    score_breakdown: Optional[Dict[str, Any]] = None

    plain_language: Dict[str, str] = {}
    all_numeric_gaps: List[Dict[str, Any]] = []
    primary_numeric_column: Optional[str] = None
    sample_rows: List[Dict[str, Any]] = []
    group_rates_map: Dict[str, float] = {}


class ChatResponse(BaseModel):
    reply: str


# ── Compliance metadata persistence ────────────────────────────────────────────


class ComplianceMetadata(BaseModel):
    dataset_name: str = "NOT PROVIDED"
    dataset_version: str = "NOT PROVIDED"
    data_source: str = "NOT PROVIDED"
    collection_method: str = "NOT PROVIDED"
    labeling_method: str = "NOT PROVIDED"
    preprocessing_steps: str = "NOT PROVIDED"
    known_biases: str = "NOT PROVIDED"
    data_minimization_justification: str = "NOT PROVIDED"

    annex_classification: str = "NOT PROVIDED"
    decision_maker: str = "NOT PROVIDED"
    decision_date: str = "NOT PROVIDED"
    justification: str = "NOT PROVIDED"

    risk_register: List[Dict[str, Any]] = Field(default_factory=list)

    lawful_basis: str = "NOT PROVIDED"
    purpose_of_processing: str = "NOT PROVIDED"
    data_categories: str = "NOT PROVIDED"
    retention_period: str = "NOT PROVIDED"
    dpia_status: str = "NOT PROVIDED"
    dpia_link: str = "NOT PROVIDED"
    dsar_process_description: str = "NOT PROVIDED"
    dpo_contact: str = "NOT PROVIDED"
    oversight_contact: str = "NOT PROVIDED"

    oversight_description: str = "NOT PROVIDED"
    escalation_contact: str = "NOT PROVIDED"
    review_sla: str = "NOT PROVIDED"
    human_intervention_points: str = "NOT PROVIDED"

    per_group_metrics: List[Dict[str, Any]] = Field(default_factory=list)
    ood_testing: str = "NOT PROVIDED"
    adversarial_testing: str = "NOT PROVIDED"
    security_assessment_link: str = "NOT PROVIDED"
    validator_name: str = "NOT PROVIDED"
    validation_date: str = "NOT PROVIDED"

    log_retention_policy: str = "NOT PROVIDED"
    log_storage_location: str = "NOT PROVIDED"
    monitoring_frequency: str = "NOT PROVIDED"
    alert_channel: str = "NOT PROVIDED"
    incident_response_description: str = "NOT PROVIDED"

    intended_use: str = "NOT PROVIDED"
    intended_users: str = "NOT PROVIDED"
    limitations: str = "NOT PROVIDED"
    known_failure_modes: str = "NOT PROVIDED"
    instructions_for_use: str = "NOT PROVIDED"

    nca_jurisdiction: str = "NOT PROVIDED"
    monitoring_cadence: str = "NOT PROVIDED"
    escalation_plan: str = "NOT PROVIDED"
    annex_confirmation: str = "NOT PROVIDED"
    countersignatures: List[Dict[str, Any]] = Field(default_factory=list)
    robustness_validation: Dict[str, Any] = Field(default_factory=dict)


class ComplianceRecord(BaseModel):
    record_id: str
    record_version: int
    deployment_locked: bool = False
    created_at: str
    updated_at: str
    integrity_hash: str
    export_integrity_hash: Optional[str] = None
    audit_result: Dict[str, Any]
    compliance_metadata: ComplianceMetadata


class ComplianceRecordRequest(BaseModel):
    record_id: Optional[str] = None
    deployment_locked: Optional[bool] = None
    audit_result: Dict[str, Any]
    compliance_metadata: Optional[ComplianceMetadata] = None


class ComplianceRecordResponse(ComplianceRecord):
    hash_valid: bool
