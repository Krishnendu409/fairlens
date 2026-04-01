import json
from pathlib import Path
from typing import Any, Dict, List


RULES_PATH = Path(__file__).resolve().parent / "rules.json"


def _status_for(metric_value: float, threshold: float, direction: str) -> str:
    if direction == "max":
        if metric_value <= threshold:
            return "Green"
        if metric_value <= threshold * 1.5:
            return "Amber"
        return "Red"
    if direction == "min":
        if metric_value >= threshold:
            return "Green"
        if metric_value >= threshold * 0.85:
            return "Amber"
        return "Red"
    return "Amber"


def _load_rules() -> Dict[str, Any]:
    with open(RULES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def evaluate_compliance(metrics_map: Dict[str, float], metadata: Dict[str, Any]) -> Dict[str, Any]:
    rules = _load_rules()
    article_results: List[Dict[str, Any]] = []
    for article in rules.get("articles", []):
        checks = []
        colors = []
        for rule in article.get("rules", []):
            kind = rule.get("kind")
            if kind == "metric":
                key = rule["metric_key"]
                value = float(metrics_map.get(key, 0.0))
                status = _status_for(value, float(rule["threshold"]), rule.get("direction", "max"))
                checks.append(
                    {
                        "type": "metric",
                        "metric_key": key,
                        "value": value,
                        "threshold": rule["threshold"],
                        "direction": rule.get("direction", "max"),
                        "status": status,
                        "reasoning": f"{key}={value} vs threshold {rule['threshold']} ({rule.get('direction','max')})",
                    }
                )
                colors.append(status)
            elif kind == "metadata_required":
                field = rule["field"]
                value = str(metadata.get(field, "")).strip()
                provided = bool(value and value.upper() != "NOT PROVIDED")
                status = "Green" if provided else "Red"
                checks.append(
                    {
                        "type": "metadata_required",
                        "field": field,
                        "provided": provided,
                        "status": status,
                        "reasoning": f"{field} {'provided' if provided else 'missing'}",
                    }
                )
                colors.append(status)
        overall = "Green"
        if "Red" in colors:
            overall = "Red"
        elif "Amber" in colors:
            overall = "Amber"
        article_results.append(
            {
                "article": article["article"],
                "title": article["title"],
                "status": overall,
                "checks": checks,
            }
        )

    return {"articles": article_results}

