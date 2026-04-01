import json
import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional

from filelock import FileLock


class JSONStorageManager:
    """
    JSON audit storage manager with strict schema and file-level locking.
    Layout:
      <base>/audits/
      <base>/reports/
      <base>/index.json
    """

    REQUIRED_KEYS = {"id", "timestamp", "input", "metrics", "compliance", "hash"}

    def __init__(self, base_dir: Optional[str] = None):
        base = base_dir or os.getenv("FAIRLENS_DATA_DIR")
        self.base_dir = Path(base) if base else Path(__file__).resolve().parents[3] / "data"
        self.audits_dir = self.base_dir / "audits"
        self.reports_dir = self.base_dir / "reports"
        self.index_path = self.base_dir / "index.json"
        self.lock_path = self.base_dir / ".storage.lock"
        self._lock = FileLock(str(self.lock_path))

        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.audits_dir.mkdir(parents=True, exist_ok=True)
        self.reports_dir.mkdir(parents=True, exist_ok=True)

        if not self.index_path.exists():
            self._atomic_write_json(self.index_path, {"audits": {}})

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    @staticmethod
    def _canonical_hash(payload: Dict[str, Any]) -> str:
        packed = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return f"SHA256:{sha256(packed.encode('utf-8')).hexdigest()}"

    def _load_index_unlocked(self) -> Dict[str, Any]:
        if not self.index_path.exists():
            return {"audits": {}}
        with open(self.index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or "audits" not in data or not isinstance(data["audits"], dict):
            return {"audits": {}}
        return data

    def _atomic_write_json(self, target: Path, payload: Dict[str, Any]) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="fairlens_", suffix=".tmp", dir=str(target.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as tmp:
                json.dump(payload, tmp, indent=2, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
            shutil.move(temp_name, target)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    @contextmanager
    def _locked(self):
        with self._lock:
            yield

    def _validate_record(self, record: Dict[str, Any]) -> None:
        missing = self.REQUIRED_KEYS - set(record.keys())
        if missing:
            raise ValueError(f"Audit record missing required fields: {sorted(missing)}")
        if not record["id"]:
            raise ValueError("Audit record id cannot be empty")

    def save_audit(
        self,
        *,
        input_data: Dict[str, Any],
        metrics: Dict[str, Any],
        compliance: Dict[str, Any],
        audit_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        record_id = audit_id or str(uuid.uuid4())
        timestamp = self._now_iso()
        hash_payload = {
            "input": input_data,
            "metrics": metrics,
            "compliance": compliance,
        }
        integrity_hash = self._canonical_hash(hash_payload)
        record = {
            "id": record_id,
            "timestamp": timestamp,
            "input": input_data,
            "metrics": metrics,
            "compliance": compliance,
            "hash": integrity_hash,
        }
        self._validate_record(record)
        record_path = self.audits_dir / f"{record_id}.json"

        with self._locked():
            self._atomic_write_json(record_path, record)
            index = self._load_index_unlocked()
            index["audits"][record_id] = {
                "id": record_id,
                "timestamp": timestamp,
                "path": str(record_path.relative_to(self.base_dir)),
                "hash": integrity_hash,
            }
            self._atomic_write_json(self.index_path, index)

        return record

    def load_audit(self, audit_id: str) -> Dict[str, Any]:
        with self._locked():
            path = self.audits_dir / f"{audit_id}.json"
            if not path.exists():
                raise FileNotFoundError(f"Audit {audit_id} not found")
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._validate_record(data)
            return data

    def list_audits(self) -> List[Dict[str, Any]]:
        with self._locked():
            index = self._load_index_unlocked()
            rows = list(index.get("audits", {}).values())
            rows.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
            return rows

    def delete_audit(self, audit_id: str) -> bool:
        with self._locked():
            path = self.audits_dir / f"{audit_id}.json"
            index = self._load_index_unlocked()
            exists = path.exists() or audit_id in index.get("audits", {})
            if path.exists():
                path.unlink()
            if audit_id in index.get("audits", {}):
                index["audits"].pop(audit_id, None)
                self._atomic_write_json(self.index_path, index)
            return exists


class ComplianceFileStore:
    """
    Backward-compatible compliance record store used by /compliance-records endpoints.
    """

    def __init__(self, store_dir: Optional[str] = None):
        base_dir = store_dir or os.getenv("COMPLIANCE_STORE_DIR")
        self.store_dir = (
            Path(base_dir)
            if base_dir
            else Path(__file__).resolve().parent / "compliance_store"
        )
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.index_file = self.store_dir / "index.json"
        self.lock_file = self.store_dir / ".lock"
        self._lock = FileLock(str(self.lock_file))
        if not self.index_file.exists():
            with open(self.index_file, "w", encoding="utf-8") as f:
                json.dump({}, f)

    def _load_index_unlocked(self) -> Dict[str, str]:
        if self.index_file.exists():
            with open(self.index_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        return {}

    def _write_index_unlocked(self, index: Dict[str, str]) -> None:
        fd, temp_name = tempfile.mkstemp(prefix="compliance_", suffix=".tmp", dir=str(self.store_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as tmp:
                json.dump(index, tmp, indent=2)
                tmp.flush()
                os.fsync(tmp.fileno())
            shutil.move(temp_name, self.index_file)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def compute_integrity_hash(self, record_id: str, updated_at: str, compliance_metadata: Dict[str, Any]) -> str:
        canonical_metadata = json.dumps(compliance_metadata, sort_keys=True, separators=(",", ":"))
        payload = f"{record_id}|{updated_at}|{canonical_metadata}"
        digest = sha256(payload.encode("utf-8")).hexdigest()
        return f"SHA256:{digest}"

    def save(self, record: Dict[str, Any], previous_hash: Optional[str] = None) -> Dict[str, Any]:
        with self._lock:
            integrity_hash = record["integrity_hash"]
            record_path = self.store_dir / f"{integrity_hash}.json"
            with open(record_path, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2, ensure_ascii=False)

            index = self._load_index_unlocked()
            index[record["record_id"]] = integrity_hash
            self._write_index_unlocked(index)

            if previous_hash and previous_hash != integrity_hash:
                old_path = self.store_dir / f"{previous_hash}.json"
                if old_path.exists():
                    old_path.unlink()
            return record

    def get(self, record_id: str) -> Dict[str, Any]:
        with self._lock:
            index = self._load_index_unlocked()
            integrity_hash = index.get(record_id)
            if not integrity_hash:
                raise FileNotFoundError(f"Record {record_id} not found")
            record_path = self.store_dir / f"{integrity_hash}.json"
            with open(record_path, "r", encoding="utf-8") as f:
                return json.load(f)

    def verify_hash(self, record: Dict[str, Any]):
        expected = self.compute_integrity_hash(
            record["record_id"], record["updated_at"], record["compliance_metadata"]
        )
        return expected == record.get("integrity_hash"), expected

    def get_current_hash(self, record_id: str) -> Optional[str]:
        with self._lock:
            return self._load_index_unlocked().get(record_id)


__all__ = ["JSONStorageManager", "ComplianceFileStore"]
