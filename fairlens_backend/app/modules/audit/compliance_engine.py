import json
from pathlib import Path
from typing import Any, Dict, List


def _level(passed: bool, warning: bool = False) -> str:
    if passed:
        return "Green"
    return "Amber" if warning else "Red"


def _metric_map(metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {m.get("key"): m.get("value") for m in metrics if isinstance(m, dict)}


def _status_score(status: str) -> float:
    if status == "Green":
        return 1.0
    if status == "Amber":
        return 0.5
    return 0.0


def _article_entry(
    article: str,
    title: str,
    status: str,
    rationale: str,
    evidence: List[str],
    gaps: List[str],
    controls: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "article": article,
        "title": title,
        "status": status,
        "score": round(_status_score(status), 2),
        "rationale": rationale,
        "evidence": evidence,
        "gaps": gaps,
        "required_controls": controls,
    }


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
    has_predictions = bool(accuracies)
    has_summary = bool((summary or "").strip())
    has_findings = bool(key_findings)
    has_recommendations = bool(recommendations)
    has_metrics = bool(metrics)
    has_groups = bool(group_stats)
    has_core_docs = has_summary and has_findings and has_recommendations

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

    # Article 11
    art11_gaps = []
    if not has_metrics:
        art11_gaps.append("Fairness metrics are missing from technical documentation output.")
    if not has_groups:
        art11_gaps.append("Per-group statistics are missing from technical documentation output.")
    if not has_core_docs:
        art11_gaps.append("Narrative sections (summary/findings/recommendations) are incomplete for technical file completeness.")
    a11_status = "Green" if not art11_gaps else ("Amber" if len(art11_gaps) <= 2 else "Red")
    a11_reason = "Technical documentation includes quantitative and narrative evidence." if not art11_gaps else " ".join(art11_gaps)

    # Article 12
    a12_status = "Amber"
    a12_reason = "Automated logging coverage is not verifiable from audit result payload alone."

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

    # Article 14
    a14_status = "Amber"
    a14_reason = "Human oversight process evidence is not directly attestable from current audit payload."

    # Article 15
    r15 = rules["article_15"]["thresholds"]
    a15_fail = []
    if min_accuracy is not None and min_accuracy < r15["min_accuracy"]:
        a15_fail.append(f"Minimum group accuracy {min_accuracy:.4f} below {r15['min_accuracy']}.")
    if tpr_gap is not None and tpr_gap > r15["max_tpr_gap"]:
        a15_fail.append(f"TPR gap {tpr_gap} exceeds {r15['max_tpr_gap']}.")
    if fpr_gap is not None and fpr_gap > r15["max_fpr_gap"]:
        a15_fail.append(f"FPR gap {fpr_gap} exceeds {r15['max_fpr_gap']}.")
    if not has_predictions:
        a15_fail.append("Prediction-column evidence is missing, so full robustness/error-rate parity checks are incomplete.")
    a15_status = _level(not a15_fail, warning=True if a15_fail else False)
    a15_reason = " ".join(a15_fail) if a15_fail else "Accuracy and fairness robustness bounds are acceptable."

    # Article 17
    a17_status = "Amber"
    a17_reason = "QMS governance controls (roles, procedures, corrective actions) require operator-provided process evidence."

    # Article 19
    a19_status = "Amber"
    a19_reason = "Automated log design/retention/access controls are not fully evidenced in current audit payload."

    # Article 72
    a72_status = "Amber"
    a72_reason = "Post-market monitoring cadence, triggers, and incident workflow evidence require deployment-time controls."

    # Annex IV
    annex_missing = []
    if not has_core_docs:
        annex_missing.append("Narrative sections are incomplete (summary/findings/recommendations).")
    if not has_metrics:
        annex_missing.append("Core metric matrix missing.")
    if not has_groups:
        annex_missing.append("Per-group evidence tables missing.")
    annex_status = "Green" if not annex_missing else ("Amber" if len(annex_missing) <= 2 else "Red")
    annex_reason = "Annex IV core technical documentation sections are materially populated." if not annex_missing else " ".join(annex_missing)

    statuses = [
        a9_status,
        a10_status,
        a11_status,
        a12_status,
        a13_status,
        a14_status,
        a15_status,
        a17_status,
        a19_status,
        a72_status,
        annex_status,
    ]
    overall = "Green"
    if "Red" in statuses:
        overall = "Red"
    elif "Amber" in statuses:
        overall = "Amber"

    gap_matrix = [
        _article_entry(
            "Art. 9",
            "Risk management system",
            a9_status,
            a9_reason,
            [f"bias_score={bias_score}"],
            [] if a9_status == "Green" else ["Residual fairness risk level is above target thresholds."],
            [] if a9_status == "Green" else [
                {
                    "id": "CTRL-A9-001",
                    "priority": "high",
                    "owner": "System Owner / Technical Lead",
                    "type": "product+process",
                    "control": "Implement and track mitigation rollout with measurable acceptance criteria and re-audit gates.",
                    "evidence": "Mitigation implementation record, post-change audit run, rollback plan.",
                }
            ],
        ),
        _article_entry(
            "Art. 10",
            "Data and data governance",
            a10_status,
            a10_reason,
            [f"DPD={dpd}", f"DIR={dir_}", f"Theil={theil}"],
            reasons_10 if reasons_10 else [],
            [] if not reasons_10 else [
                {
                    "id": "CTRL-A10-001",
                    "priority": "high",
                    "owner": "Data Governance Lead",
                    "type": "product+process",
                    "control": "Remediate representational imbalance and document provenance/collection safeguards for affected groups.",
                    "evidence": "Dataset card update, rebalancing report, fairness delta before/after.",
                }
            ],
        ),
        _article_entry(
            "Art. 11",
            "Technical documentation",
            a11_status,
            a11_reason,
            [f"metrics_present={has_metrics}", f"group_stats_present={has_groups}", f"narrative_complete={has_core_docs}"],
            art11_gaps,
            [] if not art11_gaps else [
                {
                    "id": "CTRL-A11-001",
                    "priority": "medium",
                    "owner": "Compliance Officer",
                    "type": "process",
                    "control": "Complete and version the technical file with metric evidence, assumptions, and model limitations.",
                    "evidence": "Versioned technical documentation package.",
                }
            ],
        ),
        _article_entry(
            "Art. 12",
            "Record-keeping",
            a12_status,
            a12_reason,
            ["Audit payload does not provide full runtime logging attestations."],
            ["Log completeness and traceability controls need explicit deployment evidence."],
            [
                {
                    "id": "CTRL-A12-001",
                    "priority": "medium",
                    "owner": "MLOps / Platform",
                    "type": "product+process",
                    "control": "Enable immutable decision/event logs with retention, access control, and auditability guarantees.",
                    "evidence": "Log schema, retention policy, access logs, sample trace exports.",
                }
            ],
        ),
        _article_entry(
            "Art. 13",
            "Transparency and provision of information",
            a13_status,
            a13_reason,
            [f"summary={has_summary}", f"key_findings={has_findings}", f"recommendations={has_recommendations}"],
            [f"Missing transparency fields: {', '.join(missing)}."] if missing else [],
            [] if not missing else [
                {
                    "id": "CTRL-A13-001",
                    "priority": "high",
                    "owner": "Product / Compliance",
                    "type": "process",
                    "control": "Populate missing transparency artifacts and user-facing disclosure text before release.",
                    "evidence": "Completed disclosure template and release checklist sign-off.",
                }
            ],
        ),
        _article_entry(
            "Art. 14",
            "Human oversight",
            a14_status,
            a14_reason,
            ["No direct oversight workflow proof in current payload."],
            ["Human intervention/escalation controls need explicit owner, SLA, and override path evidence."],
            [
                {
                    "id": "CTRL-A14-001",
                    "priority": "high",
                    "owner": "Operations Lead",
                    "type": "process",
                    "control": "Define human-review SOP, override procedure, and contestation turnaround SLA.",
                    "evidence": "Signed SOP, runbook, and staffed on-call rota.",
                }
            ],
        ),
        _article_entry(
            "Art. 15",
            "Accuracy, robustness and cybersecurity",
            a15_status,
            a15_reason,
            [f"min_accuracy={min_accuracy}", f"tpr_gap={tpr_gap}", f"fpr_gap={fpr_gap}", f"has_predictions={has_predictions}"],
            a15_fail,
            [] if not a15_fail else [
                {
                    "id": "CTRL-A15-001",
                    "priority": "high",
                    "owner": "ML Engineering",
                    "type": "product+process",
                    "control": "Establish predictive robustness tests and per-group error-rate guardrails with fail-open prevention.",
                    "evidence": "Validation report, threshold policy, CI gate results.",
                }
            ],
        ),
        _article_entry(
            "Art. 17",
            "Quality management system",
            a17_status,
            a17_reason,
            ["No QMS attestation fields in audit payload."],
            ["QMS structure and corrective-action governance require documented process controls."],
            [
                {
                    "id": "CTRL-A17-001",
                    "priority": "medium",
                    "owner": "Quality / Compliance",
                    "type": "process",
                    "control": "Implement AI QMS covering roles, procedures, CAPA loop, and release governance.",
                    "evidence": "Approved QMS manual and control register.",
                }
            ],
        ),
        _article_entry(
            "Art. 19",
            "Automatically generated logs",
            a19_status,
            a19_reason,
            ["Payload does not prove logging retention/access controls."],
            ["Operational log integrity and retention controls need explicit proof."],
            [
                {
                    "id": "CTRL-A19-001",
                    "priority": "medium",
                    "owner": "Platform Security",
                    "type": "product+process",
                    "control": "Enforce tamper-evident logs with retention policy, legal hold, and secure access controls.",
                    "evidence": "Retention configuration, access policy, integrity verification sample.",
                }
            ],
        ),
        _article_entry(
            "Art. 72",
            "Post-market monitoring",
            a72_status,
            a72_reason,
            ["No deployment monitoring cadence in current payload."],
            ["Monitoring cadence, alerting thresholds, and incident workflows need deployment evidence."],
            [
                {
                    "id": "CTRL-A72-001",
                    "priority": "high",
                    "owner": "MLOps",
                    "type": "process",
                    "control": "Define post-market monitoring cadence, drift triggers, escalation path, and periodic re-audit protocol.",
                    "evidence": "Monitoring plan, alert playbook, periodic audit schedule.",
                }
            ],
        ),
        _article_entry(
            "Annex IV",
            "Technical documentation content",
            annex_status,
            annex_reason,
            [f"core_docs={has_core_docs}", f"metrics_present={has_metrics}", f"group_stats_present={has_groups}"],
            annex_missing,
            [] if not annex_missing else [
                {
                    "id": "CTRL-ANNEXIV-001",
                    "priority": "medium",
                    "owner": "Compliance Officer",
                    "type": "process",
                    "control": "Complete Annex IV technical file sections and maintain versioned evidence links.",
                    "evidence": "Annex IV checklist with populated artifacts and references.",
                }
            ],
        ),
    ]

    remaining_controls = []
    seen_control_ids = set()
    for row in gap_matrix:
        if row["status"] == "Green":
            continue
        for control in row.get("required_controls", []):
            cid = control.get("id")
            if cid in seen_control_ids:
                continue
            seen_control_ids.add(cid)
            remaining_controls.append({**control, "article": row["article"], "status": "open"})

    green_count = sum(1 for s in statuses if s == "Green")
    amber_count = sum(1 for s in statuses if s == "Amber")
    red_count = sum(1 for s in statuses if s == "Red")
    rating_raw = (sum(_status_score(s) for s in statuses) / len(statuses)) * 10.0
    # Clamp defensively to rating scale bounds.
    rating_score = round(max(0.0, min(10.0, rating_raw)), 1)
    if rating_score >= 8.0:
        rating_label = "Strong but monitor"
    elif rating_score >= 6.0:
        rating_label = "Moderate / improving"
    elif rating_score >= 4.0:
        rating_label = "Weak / major gaps"
    else:
        rating_label = "Critical / non-compliant risk"
    rating_rationale = (
        f"Rating derived from article matrix status weights (Green=1, Amber=0.5, Red=0). "
        f"Current distribution: Green={green_count}, Amber={amber_count}, Red={red_count}. "
        f"Primary blockers are red/amber obligations requiring operator process evidence beyond dataset-only metrics."
    )

    return {
        "overall": overall,
        "articles": {
            "article_9": {"status": a9_status, "reasoning": a9_reason},
            "article_10": {"status": a10_status, "reasoning": a10_reason},
            "article_11": {"status": a11_status, "reasoning": a11_reason},
            "article_12": {"status": a12_status, "reasoning": a12_reason},
            "article_13": {"status": a13_status, "reasoning": a13_reason},
            "article_14": {"status": a14_status, "reasoning": a14_reason},
            "article_15": {"status": a15_status, "reasoning": a15_reason},
            "article_17": {"status": a17_status, "reasoning": a17_reason},
            "article_19": {"status": a19_status, "reasoning": a19_reason},
            "article_72": {"status": a72_status, "reasoning": a72_reason},
            "annex_iv": {"status": annex_status, "reasoning": annex_reason},
        },
        "gap_matrix": gap_matrix,
        "compliance_rating": {
            "score_1_to_10": rating_score,
            "label": rating_label,
            "rationale": rating_rationale,
            "method": "Weighted matrix average over Art. 9/10/11/12/13/14/15/17/19/72 + Annex IV",
            "distribution": {"green": green_count, "amber": amber_count, "red": red_count},
        },
        "remaining_controls": remaining_controls,
    }
