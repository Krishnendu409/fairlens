"""
audit_route.py — audit endpoints + compliance record persistence
"""

import uuid
import re
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, get_args, get_origin

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from app.schemas.audit_schema import (
    AuditRequest,
    AuditResponse,
    ChatRequest,
    ChatResponse,
    ComplianceMetadata,
    ComplianceRecordRequest,
    ComplianceRecordResponse,
    TECHNICAL_LEAD_ROLE,
    VALIDATION_ROLES,
)
from app.modules.audit.audit_service import run_audit, run_chat
from app.modules.audit.compliance_store import ComplianceFileStore

router = APIRouter(tags=["Audit"])
store = ComplianceFileStore()
HUMAN_APPROVAL_FIELDS = {
    "lawful_basis",
    "decision_maker",
    "oversight_contact",
    "oversight_description",
    "annex_confirmation",
}
AUTO_GENERATED_PLACEHOLDER_REGEX = re.compile(r"^(auto[\s-_]?computed|auto[\s-_]?generated|inferred|estimated)$", re.IGNORECASE)


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _merge_metadata(
    incoming: Optional[ComplianceMetadata], existing: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    try:
        base = ComplianceMetadata(**(existing or {})).model_dump()
    except ValidationError:
        base = ComplianceMetadata().model_dump()
    if incoming:
        inc = incoming.model_dump(exclude_none=True)
        for key, value in inc.items():
            base[key] = value
    if "robustness_validation" not in base or base["robustness_validation"] is None:
        base["robustness_validation"] = {}
    if "countersignatures" not in base or base["countersignatures"] is None:
        base["countersignatures"] = []
    return base


def _derive_robustness(audit_result: Dict[str, Any], existing: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    groups = audit_result.get("group_stats") or []
    metrics = []
    for g in groups:
        confusion = g.get("confusion") or {}
        tp, fp, tn, fn = (
            confusion.get("tp", 0),
            confusion.get("fp", 0),
            confusion.get("tn", 0),
            confusion.get("fn", 0),
        )
        total = tp + fp + tn + fn
        if total == 0:
            continue
        precision = tp / (tp + fp) if (tp + fp) > 0 else None
        recall = tp / (tp + fn) if (tp + fn) > 0 else None
        accuracy = (tp + tn) / total if total > 0 else None
        f1 = (2 * precision * recall / (precision + recall)) if precision and recall and (precision + recall) > 0 else None
        error_rate = (fp + fn) / total if total > 0 else None
        metrics.append(
            {
                "group": g.get("group"),
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "accuracy": accuracy,
                "error_rate": error_rate,
                "status": "pending_validation",
                "validator_role": TECHNICAL_LEAD_ROLE,
                "validated_by": None,
                "validated_at": None,
                "auto_computed": True,
            }
        )

    base_status = "pending_validation" if metrics else "not_documented"
    auto = {
        "status": base_status,
        "validator_role": TECHNICAL_LEAD_ROLE,
        "auto_computed": bool(metrics),
        "auto_computed_at": _iso_now(),
        "per_group": metrics,
        "ood_testing": {"status": "not_documented"},
        "adversarial_testing": {"status": "not_documented"},
    }

    if not existing:
        return auto

    merged = {**auto, **{k: v for k, v in existing.items() if v is not None}}
    existing_metrics = {m.get("group"): m for m in existing.get("per_group", []) if isinstance(m, dict)}
    merged_metrics = []
    for m in metrics:
        if m.get("group") in existing_metrics:
            previous = existing_metrics[m["group"]]
            merged_metrics.append({**m, **{k: v for k, v in previous.items() if v is not None}})
        else:
            merged_metrics.append(m)
    merged["per_group"] = merged_metrics
    return merged


def _validate_roles(metadata: Dict[str, Any]) -> None:
    for entry in metadata.get("countersignatures", []):
        role = entry.get("role")
        if role and role not in VALIDATION_ROLES:
            raise HTTPException(status_code=422, detail=f"Invalid countersignature role: {role}")
    rv = metadata.get("robustness_validation") or {}
    role = rv.get("validator_role")
    if role and role not in VALIDATION_ROLES:
        raise HTTPException(status_code=422, detail="Invalid validator role for robustness validation")
    if rv.get("status") == "validated" and role and role != TECHNICAL_LEAD_ROLE:
        raise HTTPException(
            status_code=403,
            detail="Only the Technical Lead / Model Developer may validate robustness metrics",
        )


def _normalize_structured_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    def _is_string_field(annotation: Any) -> bool:
        if annotation is str:
            return True
        origin = get_origin(annotation)
        if origin is None:
            return False
        args = get_args(annotation)
        return len(args) == 2 and str in args and type(None) in args

    for key, field in ComplianceMetadata.model_fields.items():
        if _is_string_field(field.annotation):
            val = metadata.get(key)
            normalized = str(val).strip() if val is not None and str(val).strip() else "NOT PROVIDED"
            if key in HUMAN_APPROVAL_FIELDS and AUTO_GENERATED_PLACEHOLDER_REGEX.match(normalized):
                normalized = "NOT PROVIDED"
            metadata[key] = normalized

    if not isinstance(metadata.get("risk_register"), list):
        metadata["risk_register"] = []
    if not isinstance(metadata.get("per_group_metrics"), list):
        metadata["per_group_metrics"] = []
    if not isinstance(metadata.get("countersignatures"), list):
        metadata["countersignatures"] = []
    if not isinstance(metadata.get("robustness_validation"), dict):
        metadata["robustness_validation"] = {}
    return metadata


def _build_record(payload: ComplianceRecordRequest, mark_export: bool) -> ComplianceRecordResponse:
    existing: Optional[Dict[str, Any]] = None
    previous_hash: Optional[str] = None
    if payload.record_id:
        try:
            existing = store.get(payload.record_id)
            valid, _ = store.verify_hash(existing)
            if not valid:
                raise HTTPException(
                    status_code=409,
                    detail="Stored compliance record failed integrity verification",
                )
            previous_hash = existing.get("integrity_hash")
        except FileNotFoundError:
            existing = None

    record_id = payload.record_id or str(uuid.uuid4())
    base_metadata = _merge_metadata(payload.compliance_metadata, existing.get("compliance_metadata") if existing else None)
    base_metadata["robustness_validation"] = _derive_robustness(
        payload.audit_result, base_metadata.get("robustness_validation")
    )
    base_metadata = _normalize_structured_metadata(base_metadata)
    _validate_roles(base_metadata)

    if existing and existing.get("deployment_locked"):
        current_nca = (existing.get("compliance_metadata") or {}).get("nca_jurisdiction")
        incoming_nca = base_metadata.get("nca_jurisdiction")
        if incoming_nca is not None and incoming_nca != current_nca:
            raise HTTPException(status_code=400, detail="nca_jurisdiction is locked after deployment")

    created_at = existing["created_at"] if existing else _iso_now()
    updated_at = _iso_now()
    deployment_locked = existing["deployment_locked"] if existing else False
    if payload.deployment_locked is not None:
        deployment_locked = deployment_locked or payload.deployment_locked

    record_version = (existing["record_version"] + 1) if existing else 1
    integrity_hash = store.compute_integrity_hash(record_id, updated_at, base_metadata)

    record = {
        "record_id": record_id,
        "record_version": record_version,
        "deployment_locked": deployment_locked,
        "created_at": created_at,
        "updated_at": updated_at,
        "integrity_hash": integrity_hash,
        "export_integrity_hash": existing.get("export_integrity_hash") if existing else None,
        "audit_result": payload.audit_result,
        "compliance_metadata": base_metadata,
    }

    if mark_export:
        record["export_integrity_hash"] = integrity_hash

    saved = store.save(record, previous_hash=previous_hash)
    hash_valid, _ = store.verify_hash(saved)
    return ComplianceRecordResponse(**{**saved, "hash_valid": hash_valid})


@router.post("/audit-dataset", response_model=AuditResponse)
async def audit_dataset(request: AuditRequest):
    """
    POST /audit-dataset
    Body: { dataset, description, target_column?, sensitive_column? }
    Returns structured AI fairness audit report.
    """
    try:
        return await run_audit(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Audit failed: {str(e)}")


@router.post("/audit-chat", response_model=ChatResponse)
async def audit_chat(request: ChatRequest):
    """
    POST /audit-chat
    Body: { dataset_description, audit_summary, conversation, message }
    Returns AI reply for follow-up questions about the audit.
    """
    try:
        return await run_chat(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")


@router.post("/compliance-records/snapshot", response_model=ComplianceRecordResponse)
async def create_compliance_snapshot(payload: ComplianceRecordRequest):
    """
    Create or update a compliance record and capture an export-time hash snapshot.
    """
    return _build_record(payload, mark_export=True)


@router.patch("/compliance-records/{record_id}", response_model=ComplianceRecordResponse)
async def update_compliance_record(record_id: str, payload: ComplianceRecordRequest):
    """
    Update an existing compliance record without altering the export snapshot.
    nca_jurisdiction edits are rejected once deployment_locked is true.
    """
    payload.record_id = record_id
    return _build_record(payload, mark_export=False)


@router.get("/compliance-records/{record_id}", response_model=ComplianceRecordResponse)
async def fetch_compliance_record(record_id: str):
    """
    Retrieve a compliance record and verify its integrity hash.
    """
    try:
        record = store.get(record_id)
        hash_valid, _ = store.verify_hash(record)
        return ComplianceRecordResponse(**{**record, "hash_valid": hash_valid})
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Compliance record not found")


@router.get("/sample-audit/{dataset_name}", response_model=AuditResponse)
async def sample_audit(dataset_name: str):
    dataset_map = {
        "adult": "adult_small.csv",
        "compas": "compas_small.csv",
    }
    file_name = dataset_map.get(dataset_name.lower())
    if not file_name:
        raise HTTPException(status_code=404, detail="Sample dataset not found")

    sample_path = Path(__file__).resolve().parent / "sample_data" / file_name
    if not sample_path.exists():
        raise HTTPException(status_code=500, detail="Sample dataset file missing on server")

    encoded = base64.b64encode(sample_path.read_bytes()).decode("utf-8")
    request = AuditRequest(
        dataset=encoded,
        description=f"Built-in sample audit for {dataset_name}.",
        target_column="income" if dataset_name.lower() == "adult" else "two_year_recid",
        sensitive_column="gender" if dataset_name.lower() == "adult" else "race",
        prediction_column="prediction",
        privacy_mode=True,
    )
    try:
        return await run_audit(request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sample audit failed: {exc}")
