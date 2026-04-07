import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

from config import LOG_PATH, MAX_PROMPT_CHARS


def safe_json_parse(text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def trim_prompt(prompt: str, max_chars: int = MAX_PROMPT_CHARS) -> str:
    if len(prompt) <= max_chars:
        return prompt
    suffix = "\n\n[Prompt shortened due to memory constraints. Be concise.]"
    keep = max(0, max_chars - len(suffix))
    return prompt[:keep] + suffix


def load_skill_text(path: Path, default: str = "") -> str:
    if not path.exists():
        return default
    return path.read_text(encoding="utf-8").strip()


def append_benchmark_log(payload: Dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": round(time.time(), 3), **payload}
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
