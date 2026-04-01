from app.modules.analyse.metrics.classification_metrics import (
    demographic_parity_difference,
    disparate_impact_ratio,
    tpr_gap,
    fpr_gap,
)
from app.modules.analyse.metrics.statistical_metrics import theil_index
from app.modules.analyse.metrics.engine import compute_all_metrics


def test_demographic_parity_difference():
    assert demographic_parity_difference([0.8, 0.5]) == 0.3


def test_disparate_impact_ratio():
    assert disparate_impact_ratio([0.8, 0.4]) == 0.5


def test_tpr_fpr_gap():
    assert tpr_gap([0.9, 0.7]) == 0.2
    assert fpr_gap([0.3, 0.1]) == 0.2


def test_theil_index_non_negative():
    assert theil_index([0.5, 0.5, 0.5]) == 0.0
    assert theil_index([0.2, 0.9]) >= 0.0


def test_compute_all_metrics():
    out = compute_all_metrics([0.9, 0.6], [0.8, 0.7], [0.2, 0.1])
    assert out["demographic_parity_difference"] == 0.3
    assert out["disparate_impact_ratio"] == 0.6667
    assert out["tpr_gap"] == 0.1
    assert out["fpr_gap"] == 0.1
