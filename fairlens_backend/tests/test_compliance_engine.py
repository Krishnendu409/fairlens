from app.modules.audit.compliance_engine import evaluate_eu_ai_act


def _metrics(dpd=0.08, dir_=0.85, theil=0.03, tpr=0.05, fpr=0.05):
    return [
        {"key": "demographic_parity_difference", "value": dpd},
        {"key": "disparate_impact_ratio", "value": dir_},
        {"key": "theil_index", "value": theil},
        {"key": "tpr_gap", "value": tpr},
        {"key": "fpr_gap", "value": fpr},
    ]


def test_compliance_engine_returns_dedicated_gap_matrix_and_rating():
    out = evaluate_eu_ai_act(
        bias_score=35.0,
        metrics=_metrics(),
        group_stats=[{"group": "A", "accuracy": 0.8}, {"group": "B", "accuracy": 0.78}],
        summary="ok",
        key_findings=["k1"],
        recommendations=["r1"],
    )
    assert "gap_matrix" in out
    assert isinstance(out["gap_matrix"], list)
    assert len(out["gap_matrix"]) == 11
    articles = {row["article"] for row in out["gap_matrix"]}
    assert {"Art. 9", "Art. 10", "Art. 11", "Art. 12", "Art. 13", "Art. 14", "Art. 15", "Art. 17", "Art. 19", "Art. 72", "Annex IV"} <= articles
    rating = out.get("compliance_rating", {})
    assert 1.0 <= float(rating.get("score_1_to_10", 0.0)) <= 10.0
    assert "rationale" in rating
    assert "remaining_controls" in out


def test_compliance_engine_flags_article_13_when_narrative_missing():
    out = evaluate_eu_ai_act(
        bias_score=30.0,
        metrics=_metrics(),
        group_stats=[{"group": "A", "accuracy": 0.8}, {"group": "B", "accuracy": 0.78}],
        summary="",
        key_findings=[],
        recommendations=[],
    )
    assert out["articles"]["article_13"]["status"] != "Green"
    assert any(row["article"] == "Art. 13" and row["status"] != "Green" for row in out["gap_matrix"])


def test_compliance_engine_flags_article_15_when_predictions_unavailable():
    out = evaluate_eu_ai_act(
        bias_score=20.0,
        metrics=_metrics(tpr=None, fpr=None),
        group_stats=[{"group": "A", "accuracy": None}, {"group": "B", "accuracy": None}],
        summary="ok",
        key_findings=["k1"],
        recommendations=["r1"],
    )
    assert out["articles"]["article_15"]["status"] != "Green"
    art15_row = next(row for row in out["gap_matrix"] if row["article"] == "Art. 15")
    assert any("Prediction-column evidence is missing" in g for g in art15_row["gaps"])
