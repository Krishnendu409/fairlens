import numpy as np

from app.modules.analyse.metrics.engine import compute_all_metrics


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
