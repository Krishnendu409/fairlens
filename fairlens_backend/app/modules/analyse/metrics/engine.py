from typing import Any, Dict

import numpy as np

from .classification_metrics import (
    build_confusions,
    demographic_parity_difference,
    disparate_impact_ratio,
    fpr_gap,
    group_accuracy,
    tpr_gap,
)
from .statistical_metrics import chi_square_from_counts, theil_index


def compute_all_metrics(y_true: np.ndarray, y_pred: np.ndarray, protected: np.ndarray) -> Dict[str, Any]:
    groups = sorted(set(str(g) for g in protected))
    selection_rates: Dict[str, float] = {}
    counts: Dict[str, Dict[str, int]] = {}
    for group in groups:
        mask = np.array([str(g) == group for g in protected], dtype=bool)
        yp = y_pred[mask]
        yt = y_true[mask]
        selection_rates[group] = float(np.mean(yp == 1)) if len(yp) else 0.0
        counts[group] = {
            "positive": int(np.sum(yt == 1)),
            "negative": int(np.sum(yt == 0)),
        }

    confusions = build_confusions(protected, y_true, y_pred)
    return {
        "selection_rates": selection_rates,
        "demographic_parity_difference": demographic_parity_difference(selection_rates),
        "disparate_impact_ratio": disparate_impact_ratio(selection_rates),
        "tpr_gap": tpr_gap(confusions),
        "fpr_gap": fpr_gap(confusions),
        "group_accuracy": group_accuracy(confusions),
        "theil_index": theil_index(selection_rates),
        "chi_square": chi_square_from_counts(counts),
    }
