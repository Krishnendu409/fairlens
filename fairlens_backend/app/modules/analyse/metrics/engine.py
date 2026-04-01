from typing import Dict, List, Optional

from .classification_metrics import (
    demographic_parity_difference,
    disparate_impact_ratio,
    tpr_gap,
    fpr_gap,
)
from .statistical_metrics import theil_index


def compute_all_metrics(
    pass_rates: List[float],
    tprs: Optional[List[Optional[float]]] = None,
    fprs: Optional[List[Optional[float]]] = None,
) -> Dict[str, Optional[float]]:
    out = {
        "demographic_parity_difference": demographic_parity_difference(pass_rates),
        "disparate_impact_ratio": disparate_impact_ratio(pass_rates),
        "theil_index": theil_index(pass_rates),
        "tpr_gap": None,
        "fpr_gap": None,
    }
    if tprs is not None:
        out["tpr_gap"] = tpr_gap(tprs)
    if fprs is not None:
        out["fpr_gap"] = fpr_gap(fprs)
    return out
