from typing import Dict, List, Optional

import numpy as np
from scipy import stats as scipy_stats


def theil_index(rates: List[float]) -> float:
    valid = [float(r) for r in rates if r is not None and r > 0]
    if len(valid) < 2:
        return 0.0
    mean_r = float(np.mean(valid))
    if mean_r <= 0:
        return 0.0
    value = float(np.mean([(r / mean_r) * np.log(r / mean_r) for r in valid]))
    return round(max(0.0, value), 4)


def chi_square_test(contingency_df) -> Dict[str, Optional[float]]:
    try:
        chi2, p, dof, _ = scipy_stats.chi2_contingency(contingency_df)
        n = int(contingency_df.values.sum())
        k = min(contingency_df.shape)
        cramers_v = round(float(np.sqrt(float(chi2) / (n * (k - 1)))), 4) if n > 0 and k > 1 else None
        return {
            "test": "chi_square",
            "statistic": round(float(chi2), 4),
            "p_value": round(float(p), 6),
            "is_significant": bool(p < 0.05),
            "cramers_v": cramers_v,
            "dof": int(dof),
        }
    except Exception:
        return {
            "test": "chi_square",
            "statistic": 0.0,
            "p_value": 1.0,
            "is_significant": False,
            "cramers_v": None,
            "dof": 0,
        }
