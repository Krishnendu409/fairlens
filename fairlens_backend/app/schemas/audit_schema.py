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
    privacy_mode: bool = False


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
    method_type: Optional[str] = None
    scenario_reason: Optional[str] = None
    selected_by_scenario: bool = False
    bias_score: float
    accuracy: Optional[float] = None
    precision: Optional[float] = None
    recall: Optional[float] = None
    tpr_gap: Optional[float] = None
    fpr_gap: Optional[float] = None
    dpd: float
    dir: Optional[float] = None
    before_dpd: Optional[float] = None
    after_dpd: Optional[float] = None
    before_dir: Optional[float] = None
    after_dir: Optional[float] = None
    before_accuracy: Optional[float] = None
    after_accuracy: Optional[float] = None
    before_precision: Optional[float] = None
    after_precision: Optional[float] = None
    before_recall: Optional[float] = None
    after_recall: Optional[float] = None
    improvement: float
    final_score: float
    description: str = ""


class MitigationSummary(BaseModel):
    before_bias_score: float
    results: List[MitigationMethodResult]
    best_method: str
    best_reason: str
    selected_method: Optional[str] = None
    selection_reason: Optional[str] = None
    selection_context: Dict[str, Any] = Field(default_factory=dict)
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
    privacy_mode: bool = False

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
    compliance: Optional[Dict[str, Any]] = None
    integrity_hash: Optional[str] = None
    audit_id: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str


# ── Compliance metadata persistence ────────────────────────────────────────────


class ComplianceMetadata(BaseModel):
    lawful_basis: Optional[str] = None
    purpose_of_processing: Optional[str] = None
    data_categories: Optional[str] = None
    retention_period: Optional[str] = None
    dpia_status: Optional[str] = None
    dsar_process: Optional[str] = None
    dpia_link: Optional[str] = None
    dpo_contact: Optional[str] = None
    oversight_contact: Optional[str] = None
    nca_jurisdiction: Optional[str] = None
    monitoring_cadence: Optional[str] = None
    monitoring_frequency: Optional[str] = None
    escalation_plan: Optional[str] = None
    security_assessment_status: Optional[str] = None
    annex_confirmation: Optional[str] = None
    dataset_name: Optional[str] = None
    dataset_version: Optional[str] = None
    data_source: Optional[str] = None
    collection_method: Optional[str] = None
    labeling_method: Optional[str] = None
    preprocessing_steps: Optional[str] = None
    known_biases: Optional[str] = None
    dataset_origin: Optional[str] = None
    representativeness_explanation: Optional[str] = None
    bias_sources: Optional[str] = None
    intended_use: Optional[str] = None
    intended_users: Optional[str] = None
    system_limitations: Optional[str] = None
    known_failure_modes: Optional[str] = None
    log_retention_policy: Optional[str] = None
    log_storage_location: Optional[str] = None
    alert_channel: Optional[str] = None
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
