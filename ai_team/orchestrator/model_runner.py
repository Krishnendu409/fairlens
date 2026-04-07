import time
from typing import TypedDict

import requests

try:
    from .config import (
        FALLBACK_MODELS,
        MODELS,
        OLLAMA_URL,
        RETRY_DELAY_SECONDS,
        TIMEOUT,
    )
    from .utils import trim_prompt
except ImportError:  # script execution fallback
    from config import FALLBACK_MODELS, MODELS, OLLAMA_URL, RETRY_DELAY_SECONDS, TIMEOUT
    from utils import trim_prompt


OOM_MARKERS = ("out of memory", "cuda", "memory")


class ModelRunResult(TypedDict, total=False):
    status: str
    model: str
    latency: float | None
    attempts: int
    response: str
    error: str
    used_fallback: bool


def _looks_like_oom(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in OOM_MARKERS)


def run_model(model: str, prompt: str, retries: int = 2) -> ModelRunResult:
    print(f"\n[RUNNING: {model}]")
    active_prompt = prompt
    last_error = ""
    max_attempts = retries + 1
    attempt_count = 0

    for attempt in range(1, max_attempts + 1):
        attempt_count = attempt
        try:
            start = time.time()
            response = requests.post(
                OLLAMA_URL,
                json={"model": model, "prompt": active_prompt, "stream": False},
                timeout=TIMEOUT,
            )
            latency = round(time.time() - start, 2)

            if response.status_code == 200:
                text = response.json().get("response", "")
                print(f"[DONE in {latency}s]")
                return {
                    "status": "ok",
                    "model": model,
                    "latency": latency,
                    "attempts": attempt_count,
                    "response": text,
                    "error": "",
                }

            last_error = f"HTTP {response.status_code}: {response.text}"
            print(f"[ERROR] {last_error}")
            if _looks_like_oom(last_error):
                active_prompt = trim_prompt(active_prompt)

        except Exception as exc:
            last_error = str(exc)
            print(f"[RETRY {attempt}] {last_error}")
            if _looks_like_oom(last_error):
                active_prompt = trim_prompt(active_prompt)

        if attempt < max_attempts:
            time.sleep(RETRY_DELAY_SECONDS)

    return {
        "status": "failed",
        "model": model,
        "latency": None,
        "attempts": attempt_count,
        "response": "",
        "error": last_error or "All retry attempts failed without specific error details",
    }


def run_task(task_type: str, prompt: str) -> ModelRunResult:
    model = MODELS.get(task_type, MODELS["reasoning"])
    result = run_model(model, prompt)

    if result["status"] == "ok":
        return result

    fallback_task = FALLBACK_MODELS.get(task_type)
    if not fallback_task:
        return result

    fallback_model = MODELS.get(fallback_task)
    if not fallback_model or fallback_model == model:
        return result

    print(f"[FALLBACK] {model} -> {fallback_model}")
    fallback_result = run_model(fallback_model, prompt)
    if fallback_result["status"] == "ok":
        fallback_result["used_fallback"] = True
    return fallback_result
