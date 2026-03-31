import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from app.schemas.audit_schema import ComplianceRecord


class ComplianceFileStore:
    """
    Lightweight flat-file JSON store keyed by integrity hash.
    Index file maps record_id -> latest integrity_hash for quick lookup.
    """

    def __init__(self, store_dir: Optional[str] = None):
        base_dir = store_dir or os.getenv("COMPLIANCE_STORE_DIR")
        self.store_dir = Path(base_dir) if base_dir else Path(__file__).resolve().parent / "compliance_store"
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.index_file = self.store_dir / "index.json"

    # ── Index helpers ──────────────────────────────────────────────────────────
    def _load_index(self) -> Dict[str, str]:
        if self.index_file.exists():
            with open(self.index_file, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _write_index(self, index: Dict[str, str]) -> None:
        with open(self.index_file, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2)

    # ── Hashing ────────────────────────────────────────────────────────────────
    def compute_integrity_hash(self, record_id: str, updated_at: str, compliance_metadata: Dict[str, Any]) -> str:
        canonical_metadata = json.dumps(compliance_metadata, sort_keys=True, separators=(",", ":"))
        payload = f"{record_id}|{updated_at}|{canonical_metadata}"
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        return f"SHA256:{digest}"

    # ── Persistence ────────────────────────────────────────────────────────────
    def save(self, record: Dict[str, Any], previous_hash: Optional[str] = None) -> Dict[str, Any]:
        integrity_hash = record["integrity_hash"]
        record_path = self.store_dir / f"{integrity_hash}.json"
        with open(record_path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)

        index = self._load_index()
        index[record["record_id"]] = integrity_hash
        self._write_index(index)

        if previous_hash and previous_hash != integrity_hash:
            old_path = self.store_dir / f"{previous_hash}.json"
            if old_path.exists():
                old_path.unlink()
        return record

    def get(self, record_id: str) -> Dict[str, Any]:
        index = self._load_index()
        integrity_hash = index.get(record_id)
        if not integrity_hash:
            raise FileNotFoundError(f"Record {record_id} not found")
        record_path = self.store_dir / f"{integrity_hash}.json"
        with open(record_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def verify_hash(self, record: Dict[str, Any]) -> Tuple[bool, str]:
        expected = self.compute_integrity_hash(
            record["record_id"], record["updated_at"], record["compliance_metadata"]
        )
        return expected == record.get("integrity_hash"), expected

    def get_current_hash(self, record_id: str) -> Optional[str]:
        return self._load_index().get(record_id)


__all__ = ["ComplianceFileStore"]
