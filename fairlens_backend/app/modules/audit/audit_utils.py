import base64
import hashlib
import json
from typing import Any, Dict


def _canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hash_dataset_base64(dataset_b64: str) -> str:
    payload = dataset_b64
    if dataset_b64.startswith("data:"):
        payload = dataset_b64.split(",", 1)[1]
    try:
        decoded = base64.b64decode(payload)
        source = decoded
    except Exception:
        source = payload.encode("utf-8")
    return f"SHA256:{hashlib.sha256(source).hexdigest()}"


def compute_audit_integrity_hash(
    dataset_b64: str,
    metrics: Dict[str, Any],
    compliance_result: Dict[str, Any],
) -> str:
    dataset_hash = hash_dataset_base64(dataset_b64)
    payload = f"{dataset_hash}|{_canonical_json(metrics)}|{_canonical_json(compliance_result)}"
    return f"SHA256:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


def verify_integrity(
    expected_hash: str,
    dataset_b64: str,
    metrics: Dict[str, Any],
    compliance_result: Dict[str, Any],
) -> bool:
    actual = compute_audit_integrity_hash(dataset_b64, metrics, compliance_result)
    return actual == expected_hash

