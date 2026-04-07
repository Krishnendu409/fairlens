from pathlib import Path

MODELS = {
    "reasoning": "qwen2.5:7b-instruct",
    "coding": "deepseek-coder:6.7b",
    "critic": "phi3:mini",
}

FALLBACK_MODELS = {
    "coding": "reasoning",
    "critic": "reasoning",
}

OLLAMA_URL = "http://localhost:11434/api/generate"
TIMEOUT = 120
RETRY_DELAY_SECONDS = 2
MAX_PROMPT_CHARS = 4500
LOG_PATH = Path(__file__).resolve().parents[1] / "logs" / "benchmark.jsonl"
