"""
audit_route.py — audit endpoints + compliance record persistence
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

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


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _merge_metadata(
    incoming: Optional[ComplianceMetadata], existing: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    base = ComplianceMetadata(**(existing or {})).model_dump()
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


@router.get("/sample-audit/{dataset_name}", response_model=AuditResponse)
async def sample_audit(dataset_name: str):
    """
    Run instant demo audits for built-in datasets.
    Supported: compas, adult_income
    """
    samples = {
        "compas": """race,sex,two_year_recid,prediction,age
African-American,Male,1,1,23
African-American,Male,1,1,31
Caucasian,Male,0,0,42
Caucasian,Female,0,0,37
African-American,Female,1,1,29
Caucasian,Male,0,1,51
""",
        "adult_income": """sex,income,prediction,age,hours_per_week
Male,1,1,39,40
Female,0,0,38,35
Male,1,1,28,50
Female,0,1,44,45
Male,0,0,35,20
Female,1,1,41,45
""",
    }
    key = dataset_name.strip().lower()
    if key not in samples:
        raise HTTPException(status_code=404, detail="Unknown sample dataset. Use compas or adult_income.")
    import base64

    b64 = base64.b64encode(samples[key].encode("utf-8")).decode("utf-8")
    payload = AuditRequest(
        dataset=b64,
        description=f"Sample audit for {key}",
        target_column="two_year_recid" if key == "compas" else "income",
        sensitive_column="race" if key == "compas" else "sex",
        prediction_column="prediction",
        privacy_mode=True,
    )
    try:
        return await run_audit(payload)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sample audit failed: {str(e)}")


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
