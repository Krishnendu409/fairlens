from typing import Dict, List, Optional


def demographic_parity_difference(rates: List[float]) -> float:
    if len(rates) < 2:
        return 0.0
    return round(float(max(rates) - min(rates)), 4)


def disparate_impact_ratio(rates: List[float]) -> Optional[float]:
    if len(rates) < 2:
        return 1.0
    hi = max(rates)
    if hi <= 0:
        return None
    return round(float(min(rates) / hi), 4)


def tpr_gap(tprs: List[Optional[float]]) -> Optional[float]:
    valid = [v for v in tprs if v is not None]
    if len(valid) < 2:
        return None
    return round(float(max(valid) - min(valid)), 4)


def fpr_gap(fprs: List[Optional[float]]) -> Optional[float]:
    valid = [v for v in fprs if v is not None]
    if len(valid) < 2:
        return None
    return round(float(max(valid) - min(valid)), 4)


def group_accuracy(confusion: Dict[str, int]) -> Optional[float]:
    tp = confusion.get("tp", 0)
    fp = confusion.get("fp", 0)
    tn = confusion.get("tn", 0)
    fn = confusion.get("fn", 0)
    total = tp + fp + tn + fn
    if total <= 0:
        return None
    return round(float((tp + tn) / total), 4)
