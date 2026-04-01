from typing import Dict

import numpy as np


def _safe_div(a: float, b: float, fallback: float = 0.0) -> float:
    return a / b if b else fallback


def demographic_parity_difference(selection_rates: Dict[str, float]) -> float:
    if len(selection_rates) < 2:
        return 0.0
    vals = list(selection_rates.values())
    return float(max(vals) - min(vals))


def disparate_impact_ratio(selection_rates: Dict[str, float]) -> float:
    if len(selection_rates) < 2:
        return 1.0
    vals = list(selection_rates.values())
    high = max(vals)
    low = min(vals)
    return float(_safe_div(low, high, fallback=1.0))


def tpr_gap(confusions: Dict[str, Dict[str, int]]) -> float:
    tprs = []
    for cm in confusions.values():
        tpr = _safe_div(cm["tp"], cm["tp"] + cm["fn"], fallback=0.0)
        tprs.append(tpr)
    if len(tprs) < 2:
        return 0.0
    return float(max(tprs) - min(tprs))


def fpr_gap(confusions: Dict[str, Dict[str, int]]) -> float:
    fprs = []
    for cm in confusions.values():
        fpr = _safe_div(cm["fp"], cm["fp"] + cm["tn"], fallback=0.0)
        fprs.append(fpr)
    if len(fprs) < 2:
        return 0.0
    return float(max(fprs) - min(fprs))


def group_accuracy(confusions: Dict[str, Dict[str, int]]) -> Dict[str, float]:
    out = {}
    for grp, cm in confusions.items():
        total = cm["tp"] + cm["fp"] + cm["tn"] + cm["fn"]
        out[grp] = float(_safe_div(cm["tp"] + cm["tn"], total, fallback=0.0))
    return out


def build_confusions(groups: np.ndarray, y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, Dict[str, int]]:
    conf = {}
    unique_groups = sorted(set(str(g) for g in groups))
    for group in unique_groups:
        mask = np.array([str(g) == group for g in groups], dtype=bool)
        yt = y_true[mask]
        yp = y_pred[mask]
        conf[group] = {
            "tp": int(np.sum((yt == 1) & (yp == 1))),
            "fp": int(np.sum((yt == 0) & (yp == 1))),
            "tn": int(np.sum((yt == 0) & (yp == 0))),
            "fn": int(np.sum((yt == 1) & (yp == 0))),
        }
    return conf
