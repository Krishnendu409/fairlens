import numpy as np
import pandas as pd

from app.modules.analyse.metrics.engine import compute_all_metrics
from app.modules.audit.audit_service import run_mitigation, run_statistical_test


def test_compute_all_metrics_basic():
    y_true = np.array([1, 1, 0, 0, 1, 0])
    y_pred = np.array([1, 0, 0, 0, 1, 1])
    protected = np.array(["A", "A", "A", "B", "B", "B"])

    m = compute_all_metrics(y_true=y_true, y_pred=y_pred, protected=protected)
    assert "demographic_parity_difference" in m
    assert "disparate_impact_ratio" in m
    assert "tpr_gap" in m
    assert "fpr_gap" in m
    assert "group_accuracy" in m
    assert "theil_index" in m
    assert "chi_square" in m
    assert m["demographic_parity_difference"] >= 0
    assert m["disparate_impact_ratio"] >= 0


def test_compute_all_metrics_single_group_edges():
    y_true = np.array([1, 0, 1, 0])
    y_pred = np.array([1, 0, 1, 0])
    protected = np.array(["A", "A", "A", "A"])
    m = compute_all_metrics(y_true=y_true, y_pred=y_pred, protected=protected)
    assert m["demographic_parity_difference"] == 0.0
    assert m["disparate_impact_ratio"] == 1.0
    assert m["tpr_gap"] == 0.0
    assert m["fpr_gap"] == 0.0


def test_run_statistical_test_handles_degenerate_contingency():
    df = pd.DataFrame(
        {
            "group": ["A", "A", "B", "B"],
            "target": [1, 1, 1, 1],
        }
    )
    out = run_statistical_test(df, "group", "target", positive_class=1)
    assert out["is_significant"] is False
    assert out["statistic"] == 0.0
    assert out["p_value"] == 1.0
    assert out["cramers_v"] is None


def test_run_statistical_test_returns_bias_corrected_cramers_v():
    # Strong association should produce non-negligible V and valid effect label.
    df = pd.DataFrame(
        {
            "group": ["A"] * 60 + ["B"] * 60,
            "target": ([1] * 48 + [0] * 12) + ([1] * 18 + [0] * 42),
        }
    )
    out = run_statistical_test(df, "group", "target", positive_class=1)
    assert out["cramers_v"] is not None
    assert 0.0 <= out["cramers_v"] <= 1.0
    assert out["effect_size"] in {"negligible", "small", "medium", "large"}


def test_run_mitigation_label_only_keeps_tpr_fpr_unset():
    groups = np.array(["A"] * 60 + ["B"] * 60)
    target = np.array(([1] * 36 + [0] * 24) + ([1] * 18 + [0] * 42))
    score = np.concatenate([np.linspace(0.1, 0.9, 60), np.linspace(0.2, 0.8, 60)])
    df = pd.DataFrame(
        {
            "group": groups,
            "target": target,
            "score": score,
        }
    )
    group_stats = [
        {
            "group": "A",
            "count": 60,
            "pass_rate": 0.6,
            "avg_value": 0.0,
            "pass_count": 36,
            "fail_count": 24,
            "tpr": None,
            "fpr": None,
            "accuracy": None,
            "confusion": None,
        },
        {
            "group": "B",
            "count": 60,
            "pass_rate": 0.3,
            "avg_value": 0.0,
            "pass_count": 18,
            "fail_count": 42,
            "tpr": None,
            "fpr": None,
            "accuracy": None,
            "confusion": None,
        },
    ]
    computed = {
        "bias_score": 65.0,
        "dpd": 0.3,
        "dir_": 0.5,
        "group_stats": group_stats,
        "sensitive_col": "group",
        "target_col": "target",
        "prediction_col": None,
        "positive_class": 1,
        "has_predictions": False,
        "avg_gap": 0.0,
        "theil": 0.02,
    }
    mitigation = run_mitigation(df, computed)
    assert mitigation is not None
    assert len(mitigation.results) > 0
    assert all(r.tpr_gap is None for r in mitigation.results)
    assert all(r.fpr_gap is None for r in mitigation.results)
