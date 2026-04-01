import json
from pathlib import Path
from typing import Any, Dict, List


def _level(passed: bool, warning: bool = False) -> str:
    if passed:
        return "Green"
    return "Amber" if warning else "Red"


def _metric_map(metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {m.get("key"): m.get("value") for m in metrics if isinstance(m, dict)}


def evaluate_eu_ai_act(
    *,
    bias_score: float,
    metrics: List[Dict[str, Any]],
    group_stats: List[Dict[str, Any]],
    summary: str,
    key_findings: List[str],
    recommendations: List[str],
) -> Dict[str, Any]:
    rules_path = Path(__file__).with_name("rules.json")
    with open(rules_path, "r", encoding="utf-8") as f:
        rules = json.load(f)

    metric_values = _metric_map(metrics)
    dpd = metric_values.get("demographic_parity_difference")
    dir_ = metric_values.get("disparate_impact_ratio")
    theil = metric_values.get("theil_index")
    tpr_gap = metric_values.get("tpr_gap")
    fpr_gap = metric_values.get("fpr_gap")
    accuracies = [g.get("accuracy") for g in group_stats if g.get("accuracy") is not None]
    min_accuracy = min(accuracies) if accuracies else None

    # Article 9
    r9 = rules["article_9"]["thresholds"]
    a9_status = "Green"
    if bias_score >= r9["bias_score_red_min"]:
        a9_status = "Red"
    elif bias_score >= r9["bias_score_amber_max"]:
        a9_status = "Amber"
    a9_reason = f"Bias score is {bias_score}, thresholds: amber≥{r9['bias_score_amber_max']}, red≥{r9['bias_score_red_min']}."

    # Article 10
    r10 = rules["article_10"]["thresholds"]
    a10_pass = True
    reasons_10 = []
    if dpd is not None and dpd > r10["dpd_max"]:
        a10_pass = False
        reasons_10.append(f"DPD {dpd} exceeds {r10['dpd_max']}.")
    if dir_ is not None and dir_ < r10["dir_min"]:
        a10_pass = False
        reasons_10.append(f"DIR {dir_} below {r10['dir_min']}.")
    if theil is not None and theil > r10["theil_max"]:
        a10_pass = False
        reasons_10.append(f"Theil {theil} exceeds {r10['theil_max']}.")
    a10_status = _level(a10_pass, warning=True if reasons_10 else False)
    a10_reason = " ".join(reasons_10) if reasons_10 else "Core data-governance bias metrics are within thresholds."

    # Article 13
    required = rules["article_13"]["required_fields"]
    missing = []
    if "summary" in required and not (summary or "").strip():
        missing.append("summary")
    if "key_findings" in required and not key_findings:
        missing.append("key_findings")
    if "recommendations" in required and not recommendations:
        missing.append("recommendations")
    a13_pass = len(missing) == 0
    a13_status = _level(a13_pass, warning=True)
    a13_reason = "Transparency fields complete." if a13_pass else f"Missing transparency fields: {', '.join(missing)}."

    # Article 15
    r15 = rules["article_15"]["thresholds"]
    a15_fail = []
    if min_accuracy is not None and min_accuracy < r15["min_accuracy"]:
        a15_fail.append(f"Minimum group accuracy {min_accuracy:.4f} below {r15['min_accuracy']}.")
    if tpr_gap is not None and tpr_gap > r15["max_tpr_gap"]:
        a15_fail.append(f"TPR gap {tpr_gap} exceeds {r15['max_tpr_gap']}.")
    if fpr_gap is not None and fpr_gap > r15["max_fpr_gap"]:
        a15_fail.append(f"FPR gap {fpr_gap} exceeds {r15['max_fpr_gap']}.")
    a15_status = _level(not a15_fail, warning=True if a15_fail else False)
    a15_reason = " ".join(a15_fail) if a15_fail else "Accuracy and fairness robustness bounds are acceptable."

    statuses = [a9_status, a10_status, a13_status, a15_status]
    overall = "Green"
    if "Red" in statuses:
        overall = "Red"
    elif "Amber" in statuses:
        overall = "Amber"

    return {
        "overall": overall,
        "articles": {
            "article_9": {"status": a9_status, "reasoning": a9_reason},
            "article_10": {"status": a10_status, "reasoning": a10_reason},
            "article_13": {"status": a13_status, "reasoning": a13_reason},
            "article_15": {"status": a15_status, "reasoning": a15_reason},
        },
    }
