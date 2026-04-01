import fcntl
import hashlib
import json
import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class JSONStorageManager:
    """
    Structured JSON storage manager with concurrency-safe index updates.
    Storage layout:
      <base>/data/audits/*.json
      <base>/data/reports/*.json
      <base>/data/index.json
    """

    def __init__(self, base_dir: Optional[str] = None):
        resolved_base = base_dir or os.getenv("COMPLIANCE_STORE_DIR")
        root = Path(resolved_base) if resolved_base else Path(__file__).resolve().parent
        self.data_dir = root / "data"
        self.audits_dir = self.data_dir / "audits"
        self.reports_dir = self.data_dir / "reports"
        self.index_file = self.data_dir / "index.json"
        self.lock_file = self.data_dir / ".lock"

        self.audits_dir.mkdir(parents=True, exist_ok=True)
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self.lock_file.touch(exist_ok=True)
        if not self.index_file.exists():
            self._write_json(self.index_file, {"audits": {}, "reports": {}})

    @contextmanager
    def _global_lock(self):
        with open(self.lock_file, "r+", encoding="utf-8") as lockf:
            fcntl.flock(lockf, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lockf, fcntl.LOCK_UN)

    @staticmethod
    def _read_json(path: Path) -> Dict[str, Any]:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _write_json(path: Path, payload: Dict[str, Any]) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

    @staticmethod
    def _hash_payload(payload: Dict[str, Any]) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return f"SHA256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"

    def _load_index(self) -> Dict[str, Dict[str, str]]:
        if not self.index_file.exists():
            return {"audits": {}, "reports": {}}
        idx = self._read_json(self.index_file)
        if "audits" not in idx:
            idx["audits"] = {}
        if "reports" not in idx:
            idx["reports"] = {}
        return idx

    def _write_index(self, index: Dict[str, Dict[str, str]]) -> None:
        self._write_json(self.index_file, index)

    def _validate_audit_schema(self, record: Dict[str, Any]) -> Dict[str, Any]:
        required = ("id", "timestamp", "input", "metrics", "compliance", "hash")
        for key in required:
            if key not in record:
                raise ValueError(f"Invalid audit schema: missing '{key}'")
        if not isinstance(record["input"], dict):
            raise ValueError("Invalid audit schema: 'input' must be an object")
        if not isinstance(record["metrics"], dict):
            raise ValueError("Invalid audit schema: 'metrics' must be an object")
        if not isinstance(record["compliance"], dict):
            raise ValueError("Invalid audit schema: 'compliance' must be an object")
        return record

    def save_audit(
        self,
        input_payload: Dict[str, Any],
        metrics: Dict[str, Any],
        compliance: Dict[str, Any],
        audit_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._global_lock():
            record_id = audit_id or str(uuid.uuid4())
            timestamp = _utc_now_iso()
            base = {
                "id": record_id,
                "timestamp": timestamp,
                "input": input_payload,
                "metrics": metrics,
                "compliance": compliance,
            }
            digest = self._hash_payload(base)
            record = {**base, "hash": digest}
            self._validate_audit_schema(record)

            path = self.audits_dir / f"{record_id}.json"
            self._write_json(path, record)

            index = self._load_index()
            index["audits"][record_id] = str(path)
            self._write_index(index)
            return record

    def load_audit(self, audit_id: str) -> Dict[str, Any]:
        with self._global_lock():
            index = self._load_index()
            path_str = index.get("audits", {}).get(audit_id)
            if not path_str:
                raise FileNotFoundError(f"Audit {audit_id} not found")
            record = self._read_json(Path(path_str))
            return self._validate_audit_schema(record)

    def list_audits(self) -> List[Dict[str, Any]]:
        with self._global_lock():
            index = self._load_index()
            audits: List[Dict[str, Any]] = []
            for path_str in index.get("audits", {}).values():
                path = Path(path_str)
                if not path.exists():
                    continue
                audits.append(self._validate_audit_schema(self._read_json(path)))
            return sorted(audits, key=lambda item: item["timestamp"], reverse=True)

    def delete_audit(self, audit_id: str) -> bool:
        with self._global_lock():
            index = self._load_index()
            path_str = index.get("audits", {}).pop(audit_id, None)
            self._write_index(index)
            if not path_str:
                return False
            path = Path(path_str)
            if path.exists():
                path.unlink()
            return True

    # Backward-compatible compliance helpers
    def compute_integrity_hash(self, record_id: str, updated_at: str, compliance_metadata: Dict[str, Any]) -> str:
        payload = {
            "id": record_id,
            "timestamp": updated_at,
            "input": {},
            "metrics": {},
            "compliance": compliance_metadata,
        }
        return self._hash_payload(payload)

    def save(self, record: Dict[str, Any], previous_hash: Optional[str] = None) -> Dict[str, Any]:
        with self._global_lock():
            report_id = record["record_id"]
            report_path = self.reports_dir / f"{report_id}.json"
            self._write_json(report_path, record)

            index = self._load_index()
            index["reports"][report_id] = str(report_path)
            self._write_index(index)
            return record

    def get(self, record_id: str) -> Dict[str, Any]:
        with self._global_lock():
            index = self._load_index()
            path_str = index.get("reports", {}).get(record_id)
            if not path_str:
                raise FileNotFoundError(f"Record {record_id} not found")
            return self._read_json(Path(path_str))

    def verify_hash(self, record: Dict[str, Any]) -> Tuple[bool, str]:
        expected = self.compute_integrity_hash(
            record["record_id"],
            record["updated_at"],
            record["compliance_metadata"],
        )
        return expected == record.get("integrity_hash"), expected

    def get_current_hash(self, record_id: str) -> Optional[str]:
        with self._global_lock():
            index = self._load_index()
            path_str = index.get("reports", {}).get(record_id)
            if not path_str:
                return None
            record = self._read_json(Path(path_str))
            return record.get("integrity_hash")


ComplianceFileStore = JSONStorageManager

__all__ = ["JSONStorageManager", "ComplianceFileStore"]
