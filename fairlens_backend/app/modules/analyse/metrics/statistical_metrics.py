from typing import Dict

import numpy as np
from scipy import stats as scipy_stats


def theil_index(values: Dict[str, float]) -> float:
    vals = [float(v) for v in values.values() if v is not None and float(v) > 0]
    if len(vals) < 2:
        return 0.0
    mean_v = float(np.mean(vals))
    if mean_v <= 0:
        return 0.0
    return float(np.mean([(v / mean_v) * np.log(v / mean_v) for v in vals]))


def chi_square_from_counts(group_positive_negative: Dict[str, Dict[str, int]]) -> Dict[str, float | bool]:
    if len(group_positive_negative) < 2:
        return {"chi2": 0.0, "p_value": 1.0, "is_significant": False}
    matrix = []
    for counts in group_positive_negative.values():
        matrix.append([int(counts.get("positive", 0)), int(counts.get("negative", 0))])
    chi2, p, _, _ = scipy_stats.chi2_contingency(np.array(matrix))
    return {"chi2": float(chi2), "p_value": float(p), "is_significant": bool(p < 0.05)}
