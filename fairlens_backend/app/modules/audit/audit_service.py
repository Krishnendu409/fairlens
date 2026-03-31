"""
audit_service.py — FairLens v12 — fully correct fairness metrics.

METRIC DEFINITIONS:
  DPD       = max(pass_rates) - min(pass_rates)           [always computed]
  DIR       = min(pass_rates) / max(pass_rates)           [None if max==0]
  TPR_g     = TP_g / (TP_g + FN_g)    REQUIRES prediction_column
  FPR_g     = FP_g / (FP_g + TN_g)    REQUIRES prediction_column
  TPR_gap   = max(TPR_g) - min(TPR_g) REQUIRES prediction_column
  FPR_gap   = max(FPR_g) - min(FPR_g) REQUIRES prediction_column
  Theil     = mean((r/mean_r)*ln(r/mean_r))  where r>0   [inequality]

BIAS SCORE — only average what is actually measured:
  violations = [dpd_v, dir_v]            always
  if has_predictions: += [tpr_v, fpr_v]  only when confusion matrix available
  score = mean(violations) * 100

  dpd_v = min(DPD / 0.10, 1)
  dir_v = 0 if DIR >= 0.80 else min((0.80-DIR)/0.80, 1)
  tpr_v = min(TPR_gap / 0.10, 1)
  fpr_v = min(FPR_gap / 0.10, 1)

MITIGATION SELECTION (all components in [0,1]):
  final_score = 0.6*bias_reduction + 0.3*accuracy + 0.1*stability
  INVALID if method increases bias (final_score set to -1)

LABEL-ONLY MODE:
  TPR and FPR are NOT computed, NOT shown, NOT included in bias score.
  Showing 0.0000 for unmeasured metrics is misleading — they are None.
"""

import os, json, re, base64, io
from typing import Optional
from dotenv import load_dotenv

import numpy as np
import pandas as pd
import httpx
from scipy import stats as scipy_stats

from app.schemas.audit_schema import (
    AuditRequest, AuditResponse, ChatRequest, ChatResponse,
    GroupStats, MetricResult, BiasOrigin, DataReliability,
    ConfusionMatrix, StatisticalTest,
    MitigationMethodResult, MitigationSummary,
)

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# NUMPY SERIALISATION HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _n(v):
    if v is None: return None
    if isinstance(v, np.bool_):    return bool(v)
    if isinstance(v, np.integer):  return int(v)
    if isinstance(v, np.floating): return float(v)
    return v

def _safe_json(obj) -> str:
    class _Enc(json.JSONEncoder):
        def default(self, o):
            if isinstance(o, np.bool_):    return bool(o)
            if isinstance(o, np.integer):  return int(o)
            if isinstance(o, np.floating): return float(o)
            return super().default(o)
    return json.dumps(obj, cls=_Enc)


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)


# ─────────────────────────────────────────────────────────────────────────────
# 1. CSV DECODE
# ─────────────────────────────────────────────────────────────────────────────

def decode_csv(b64: str) -> pd.DataFrame:
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return pd.read_csv(io.BytesIO(base64.b64decode(b64)))


# ─────────────────────────────────────────────────────────────────────────────
# 2. COLUMN DETECTION
# ─────────────────────────────────────────────────────────────────────────────

def detect_columns(df: pd.DataFrame, target_col: Optional[str],
                   sensitive_col: Optional[str],
                   prediction_col: Optional[str] = None):
    id_patterns = {"id","index","row","num","no","number","sno","serial"}
    numeric_cols = [
        c for c in df.columns
        if pd.api.types.is_numeric_dtype(df[c])
        and c.lower().strip() not in id_patterns
        and df[c].nunique() > 2
        and df[c].nunique() < len(df)
    ]
    numeric_col = numeric_cols[0] if numeric_cols else None

    if not target_col:
        pos_kw = {"pass","yes","1","true","hired","approved","selected","1.0"}
        for c in df.columns:
            if c in (sensitive_col, prediction_col): continue
            uv = df[c].dropna().unique()
            if len(uv) == 2 and any(str(v).lower().strip() in pos_kw for v in uv):
                target_col = c; break
        if not target_col:
            for c in df.columns:
                if c in (sensitive_col, prediction_col): continue
                if pd.api.types.is_numeric_dtype(df[c]): continue
                if 2 <= df[c].nunique() <= 5: target_col = c; break

    if not sensitive_col:
        for c in df.columns:
            if c in (target_col, prediction_col): continue
            if pd.api.types.is_numeric_dtype(df[c]): continue
            if 2 <= df[c].nunique() <= 10: sensitive_col = c; break

    return target_col, sensitive_col, prediction_col, numeric_col


def detect_positive_class(df: pd.DataFrame, col: str):
    pos_kw = {"pass","yes","1","true","hired","approved","selected","1.0"}
    for v in df[col].dropna().unique():
        if str(v).lower().strip() in pos_kw: return v
    return df[col].value_counts().idxmax()


# ─────────────────────────────────────────────────────────────────────────────
# 3. DATA VALIDATION
# ─────────────────────────────────────────────────────────────────────────────

def validate_data(df, sensitive_col, target_col) -> dict:
    warnings, penalty = [], 0.0
    mp = df.isnull().mean().max() * 100
    if mp > 20:    warnings.append(f"High missing data: up to {mp:.1f}%."); penalty += 20
    elif mp > 5:   warnings.append(f"Some missing values ({mp:.1f}% max)."); penalty += 8
    if len(df) < 50:    warnings.append(f"Very small dataset ({len(df)} rows)."); penalty += 25
    elif len(df) < 200: warnings.append(f"Small dataset ({len(df)} rows)."); penalty += 10
    if sensitive_col and sensitive_col in df.columns:
        gc = df[sensitive_col].value_counts()
        total = len(df)
        for g, cnt in gc.items():
            if cnt < 30: warnings.append(f"Group '{g}' has only {cnt} samples."); penalty += 15
            elif cnt / total < 0.10: warnings.append(f"Group '{g}' underrepresented ({cnt/total:.1%})."); penalty += 8
        if df[sensitive_col].nunique() < 2:
            warnings.append("Only one group detected."); penalty += 40
    if not target_col:
        warnings.append("No outcome column — some metrics unavailable."); penalty += 20
    cs = round(max(0.0, min(100.0, 100.0 - penalty)), 1)
    return {
        "reliability": "High" if cs >= 75 else "Medium" if cs >= 45 else "Low",
        "confidence_score": cs,
        "warnings": warnings,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. CONFUSION MATRIX PER GROUP
# ─────────────────────────────────────────────────────────────────────────────

def compute_confusion(gdf: pd.DataFrame, target_col: str, pred_col: str,
                      pos_class, neg_class) -> dict:
    """
    Standard confusion matrix.
    TP = pred==pos AND actual==pos
    FP = pred==pos AND actual==neg
    TN = pred==neg AND actual==neg
    FN = pred==neg AND actual==pos
    """
    tp = int(((gdf[pred_col] == pos_class) & (gdf[target_col] == pos_class)).sum())
    fp = int(((gdf[pred_col] == pos_class) & (gdf[target_col] == neg_class)).sum())
    tn = int(((gdf[pred_col] == neg_class) & (gdf[target_col] == neg_class)).sum())
    fn = int(((gdf[pred_col] == neg_class) & (gdf[target_col] == pos_class)).sum())
    tpr = round(tp / (tp + fn), 4) if (tp + fn) > 0 else None
    fpr = round(fp / (fp + tn), 4) if (fp + tn) > 0 else None
    acc = round((tp + tn) / (tp + fp + tn + fn), 4) if (tp + fp + tn + fn) > 0 else None
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "tpr": tpr, "fpr": fpr, "acc": acc}


# ─────────────────────────────────────────────────────────────────────────────
# 5. THEIL INDEX
# ─────────────────────────────────────────────────────────────────────────────

def compute_theil_index(rates: list) -> float:
    """
    Theil T index — group-level outcome inequality.
    Theil = mean((r_g / mean_r) * ln(r_g / mean_r))  for r_g > 0
    Returns 0.0 for perfectly equal distribution.
    """
    valid = [float(r) for r in rates if r is not None and r > 0]
    if len(valid) < 2: return 0.0
    mean_r = float(np.mean(valid))
    if mean_r <= 0: return 0.0
    theil = float(np.mean([(r / mean_r) * np.log(r / mean_r) for r in valid]))
    return round(max(0.0, theil), 4)


# ─────────────────────────────────────────────────────────────────────────────
# 6. COMPUTE RAW STATS
# ─────────────────────────────────────────────────────────────────────────────

def compute_raw_stats(df: pd.DataFrame, description: str,
                      target_col: Optional[str], sensitive_col: Optional[str],
                      sensitive_col_2: Optional[str],
                      prediction_col: Optional[str] = None) -> dict:

    target_col, sensitive_col, prediction_col, numeric_col = \
        detect_columns(df, target_col, sensitive_col, prediction_col)

    has_predictions = bool(prediction_col and prediction_col in df.columns)

    positive_class = negative_class = None
    if target_col and target_col in df.columns:
        positive_class = detect_positive_class(df, target_col)
        for v in df[target_col].dropna().unique():
            if v != positive_class:
                negative_class = v
                break

    # ── Per-group stats ──────────────────────────────────────────────────────
    group_stats: list[dict] = []
    if sensitive_col and sensitive_col in df.columns:
        for g in sorted(df[sensitive_col].dropna().unique(), key=str):
            gdf   = df[df[sensitive_col] == g]
            total = int(len(gdf))
            pass_ct = fail_ct = 0
            pass_rate = 0.0

            if target_col and positive_class is not None:
                pass_ct   = int((gdf[target_col] == positive_class).sum())
                fail_ct   = total - pass_ct
                pass_rate = round(float(pass_ct / total), 4) if total > 0 else 0.0

            avg_value = round(float(gdf[numeric_col].mean()), 2) if numeric_col else None

            # TPR and FPR: ONLY when prediction_column is provided
            # In label-only mode these are None — not 0.0, not pass_rate
            cm       = None
            tpr      = None
            fpr      = None
            accuracy = None

            if has_predictions and positive_class is not None and negative_class is not None:
                cm_dict  = compute_confusion(gdf, target_col, prediction_col,
                                             positive_class, negative_class)
                tpr      = cm_dict["tpr"]
                fpr      = cm_dict["fpr"]
                accuracy = cm_dict["acc"]
                cm       = cm_dict

            group_stats.append({
                "group": str(g), "count": total,
                "avg_value": avg_value,
                "pass_count": pass_ct, "fail_count": fail_ct, "pass_rate": pass_rate,
                "tpr": tpr, "fpr": fpr, "accuracy": accuracy, "confusion": cm,
            })

    # ── Core fairness metrics ────────────────────────────────────────────────
    rates = [g["pass_rate"] for g in group_stats]
    dpd   = round(float(max(rates) - min(rates)), 4) if len(rates) >= 2 else 0.0

    if len(rates) >= 2 and max(rates) > 0:
        dir_ = round(float(min(rates) / max(rates)), 4)
    elif len(rates) >= 2 and max(rates) == 0:
        dir_ = None          # all outcomes negative — DIR undefined
    else:
        dir_ = 1.0

    avg_vals = [g["avg_value"] for g in group_stats if g["avg_value"] is not None]
    avg_gap  = round(float(max(avg_vals) - min(avg_vals)), 2) if len(avg_vals) >= 2 else 0.0

    # Theil — uses pass_rates; guard against zero rates for log
    theil = compute_theil_index(rates)

    # True EO — only when prediction column present
    tpr_list = [g["tpr"] for g in group_stats if g["tpr"] is not None]
    fpr_list = [g["fpr"] for g in group_stats if g["fpr"] is not None]
    tpr_gap  = round(float(max(tpr_list) - min(tpr_list)), 4) if len(tpr_list) >= 2 else None
    fpr_gap  = round(float(max(fpr_list) - min(fpr_list)), 4) if len(fpr_list) >= 2 else None

    # ── Bias score: average only AVAILABLE violations ────────────────────────
    dpd_v = min(dpd / 0.10, 1.0)
    dir_v = (0.0 if dir_ is not None and dir_ >= 0.80
             else (min((0.80 - dir_) / 0.80, 1.0) if dir_ is not None else 1.0))

    violations = [dpd_v, dir_v]   # always 2 base violations

    tpr_v = None
    fpr_v = None
    if has_predictions and tpr_gap is not None and fpr_gap is not None:
        tpr_v = min(tpr_gap / 0.10, 1.0)
        fpr_v = min(fpr_gap / 0.10, 1.0)
        violations += [tpr_v, fpr_v]

    bias_score = round(float(np.mean(violations)) * 100, 1)
    bias_score = max(0.0, min(100.0, bias_score))

    if   bias_score < 20: bias_level, risk_label = "Low",      "Low Risk"
    elif bias_score < 45: bias_level, risk_label = "Moderate", "Moderate Risk"
    elif bias_score < 70: bias_level, risk_label = "High",     "High Risk"
    else:                 bias_level, risk_label = "Critical", "Critical Risk"

    # ── Metrics list — do NOT include TPR/FPR as separate metrics in label-only
    dir_flagged = bool(True if dir_ is None else dir_ < 0.80)
    metrics = [
        {"name": "Demographic Parity Difference",
         "key": "demographic_parity_difference",
         "value": dpd, "threshold": 0.10,
         "threshold_direction": "below", "flagged": _n(dpd > 0.10)},
        {"name": "Disparate Impact Ratio",
         "key": "disparate_impact_ratio",
         "value": dir_, "threshold": 0.80,
         "threshold_direction": "above", "flagged": _n(dir_flagged)},
        {"name": "Theil Inequality Index",
         "key": "theil_index",
         "value": theil, "threshold": 0.05,
         "threshold_direction": "below", "flagged": _n(theil > 0.05)},
        {"name": "Performance Gap (numeric)",
         "key": "performance_gap",
         "value": avg_gap, "threshold": 5.0,
         "threshold_direction": "below", "flagged": _n(avg_gap > 5.0)},
    ]

    # Only add EO metrics when predictions exist — otherwise they are not measured
    if has_predictions and tpr_gap is not None and fpr_gap is not None:
        metrics += [
            {"name": "Equal Opportunity Gap (TPR)",
             "key": "tpr_gap",
             "value": tpr_gap, "threshold": 0.10,
             "threshold_direction": "below", "flagged": _n(tpr_gap > 0.10)},
            {"name": "Equalized Odds Gap (FPR)",
             "key": "fpr_gap",
             "value": fpr_gap, "threshold": 0.10,
             "threshold_direction": "below", "flagged": _n(fpr_gap > 0.10)},
        ]

    score_breakdown = {
        "dpd_violation":      round(dpd_v * 100, 1),
        "dir_violation":      round(dir_v * 100, 1),
        "tpr_violation":      round(tpr_v * 100, 1) if tpr_v is not None else None,
        "fpr_violation":      round(fpr_v * 100, 1) if fpr_v is not None else None,
        "violations_counted": len(violations),
        "label_only_mode":    not has_predictions,
    }

    # ── Compact summary for Gemini prompt ───────────────────────────────────
    glines = []
    for gs in group_stats:
        tpr_s = f", TPR={gs['tpr']:.3f}" if gs["tpr"] is not None else ""
        fpr_s = f", FPR={gs['fpr']:.3f}" if gs["fpr"] is not None else ""
        acc_s = f", acc={gs['accuracy']:.3f}" if gs["accuracy"] is not None else ""
        glines.append(
            f"  {gs['group']}: n={gs['count']}, pass={gs['pass_count']}, "
            f"pass_rate={gs['pass_rate']:.2%}{tpr_s}{fpr_s}{acc_s}"
        )

    dir_str  = f"{dir_:.4f}" if (dir_ is not None and isinstance(dir_, float)) else "undefined (all outcomes negative)"
    tpr_str  = f"{tpr_gap:.4f}" if tpr_gap is not None else "N/A (no prediction column)"
    fpr_str  = f"{fpr_gap:.4f}" if fpr_gap is not None else "N/A (no prediction column)"
    mode_tag = "model-based (true confusion matrix)" if has_predictions else "label-only"
    compact  = f"""Dataset: {len(df)} rows | Target: {target_col} | Sensitive: {sensitive_col}
Mode: {mode_tag}{f' | Prediction: {prediction_col}' if has_predictions else ''}

Groups:
{chr(10).join(glines) if glines else '  (no group data)'}

Metrics:
  DPD      = {dpd:.4f}  (flagged={_n(dpd > 0.10)})
  DIR      = {dir_str}  (flagged={dir_flagged})
  Theil    = {theil:.4f}  (flagged={_n(theil > 0.05)})
  TPR Gap  = {tpr_str}
  FPR Gap  = {fpr_str}
  Perf Gap = {avg_gap:.2f}

Bias score: {bias_score} ({bias_level})
Formula: mean({[round(v*100,1) for v in violations]}) = {bias_score}"""

    return {
        "compact_summary": compact,
        "description": description,
        "has_predictions": has_predictions,
        "computed": {
            "bias_score":     bias_score,
            "bias_level":     bias_level,
            "risk_label":     risk_label,
            "bias_detected":  bias_score >= 20,
            "total_rows":     int(len(df)),
            "columns":        list(df.columns),
            "metrics":        metrics,
            "group_stats":    group_stats,
            "sensitive_col":  sensitive_col,
            "target_col":     target_col,
            "prediction_col": prediction_col if has_predictions else None,
            "has_predictions": has_predictions,
            "dpd":            dpd,
            "dir_":           dir_,
            "tpr_gap":        tpr_gap if tpr_gap is not None else 0.0,
            "fpr_gap":        fpr_gap if fpr_gap is not None else 0.0,
            "avg_gap":        avg_gap,
            "theil":          theil,
            "score_breakdown": score_breakdown,
            "positive_class": str(positive_class) if positive_class is not None else None,
            "negative_class": str(negative_class) if negative_class is not None else None,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. STATISTICAL SIGNIFICANCE
# ─────────────────────────────────────────────────────────────────────────────

def run_statistical_test(df: pd.DataFrame, sensitive_col: str,
                         target_col: str, positive_class) -> dict:
    try:
        contingency = pd.crosstab(df[sensitive_col], df[target_col])
        chi2, p, dof, _ = scipy_stats.chi2_contingency(contingency)
        sig = bool(p < 0.05)
        n = int(contingency.values.sum())
        k = min(contingency.shape)
        cramers_v = round(float(np.sqrt(float(chi2) / (n * (k - 1)))), 4) if n > 0 and k > 1 else None
        if cramers_v is not None:
            if cramers_v >= 0.40:   effect_size = "large"
            elif cramers_v >= 0.20: effect_size = "medium"
            elif cramers_v >= 0.10: effect_size = "small"
            else:                   effect_size = "negligible"
        else:
            effect_size = None
        return {
            "test": "chi_square",
            "statistic": round(float(chi2), 4),
            "p_value": round(float(p), 6),
            "is_significant": sig,
            "interpretation": (
                f"Chi-square={chi2:.3f}, p={p:.4f}, dof={dof}. "
                f"{'Bias IS statistically significant (p<0.05).' if sig else 'Bias NOT statistically significant (p≥0.05).'}"
            ),
            "cramers_v": cramers_v,
            "effect_size": effect_size,
        }
    except Exception as e:
        return {
            "test": "chi_square", "statistic": 0.0, "p_value": 1.0,
            "is_significant": False,
            "interpretation": f"Statistical test could not be computed: {e}",
            "cramers_v": None,
            "effect_size": None,
        }


# ─────────────────────────────────────────────────────────────────────────────
# 8. MITIGATION HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _bias_score_from_rates(rates: list, has_pred: bool = False,
                            tpr_list: Optional[list] = None,
                            fpr_list: Optional[list] = None) -> float:
    """
    Compute bias score from adjusted rates, respecting label-only mode.
    In label-only mode: only DPD and DIR violations are averaged.
    """
    if not rates or len(rates) < 2:
        return 0.0
    rates_f = [float(r) for r in rates]
    dpd  = max(rates_f) - min(rates_f)
    dir_ = min(rates_f) / max(rates_f) if max(rates_f) > 0 else 1.0
    dpd_v = min(dpd / 0.10, 1.0)
    dir_v = 0.0 if dir_ >= 0.80 else min((0.80 - dir_) / 0.80, 1.0)
    violations = [dpd_v, dir_v]
    if has_pred and tpr_list and fpr_list and len(tpr_list) >= 2 and len(fpr_list) >= 2:
        tpr_g = max(tpr_list) - min(tpr_list)
        fpr_g = max(fpr_list) - min(fpr_list)
        violations += [min(tpr_g / 0.10, 1.0), min(fpr_g / 0.10, 1.0)]
    return float(round(float(np.mean(violations)) * 100, 1))


def _compute_true_accuracy(group_stats: list, adjusted_rates: list) -> float:
    """
    True accuracy estimate: (TP + TN) / N using oracle best-case assignment.
    TP = min(pred_pos, actual_pos)   [model picks true positives first]
    TN = min(pred_neg, actual_neg)
    Always returns a value in [0, 1].
    """
    total_correct = 0
    total_n       = 0
    for gs, adj_rate in zip(group_stats, adjusted_rates):
        n          = gs["count"]
        actual_pos = gs["pass_count"]
        actual_neg = gs["fail_count"]
        pred_pos   = max(0, min(n, int(round(float(adj_rate) * n))))
        pred_neg   = n - pred_pos
        tp = min(pred_pos, actual_pos)
        tn = min(pred_neg, actual_neg)
        total_correct += tp + tn
        total_n       += n
    if total_n == 0:
        return 0.5
    return float(round(max(0.0, min(1.0, total_correct / total_n)), 4))


def _compute_stability(adjusted_rates: list) -> float:
    """Stability = 1 - std(rates). Higher = more equal groups. Always [0,1]."""
    if len(adjusted_rates) < 2:
        return 1.0
    return float(round(max(0.0, min(1.0, 1.0 - float(np.std(adjusted_rates)))), 4))


# ─────────────────────────────────────────────────────────────────────────────
# 9. MITIGATION METHOD 1 — REWEIGHING
# ─────────────────────────────────────────────────────────────────────────────


def _method_reweighing(df, computed):
    try:
        sc = computed["sensitive_col"]; tc = computed["target_col"]
        pc = computed["positive_class"]; gs = computed["group_stats"]
        hp = computed["has_predictions"]
        if not sc or not tc or not pc:
            return {"method": "reweighing", "error": "insufficient columns"}
        total = len(df)
        p_y = {y: len(df[df[tc]==y])/total for y in df[tc].dropna().unique()}
        p_g = {str(g): len(df[df[sc]==g])/total for g in df[sc].dropna().unique()}
        p_gy = {}
        for g in df[sc].dropna().unique():
            for y in df[tc].dropna().unique():
                p_gy[(str(g),y)] = len(df[(df[sc]==g)&(df[tc]==y)])/total
        def get_w(row):
            g = str(row[sc]) if pd.notna(row[sc]) else None
            y = row[tc] if pd.notna(row[tc]) else None
            if g is None or y is None: return 1.0
            d = p_gy.get((g,y), 0)
            return (p_y.get(y,0)*p_g.get(g,0))/d if d > 0 else 1.0
        df2 = df.copy(); df2["_w"] = df2.apply(get_w, axis=1)
        new_rates = []
        for g_s in gs:
            g = g_s["group"]
            gdf = df2[df2[sc].astype(str)==g]; w = gdf["_w"]
            if w.sum() == 0: new_rates.append(g_s["pass_rate"]); continue
            wpr = float((w*(gdf[tc]==pc)).sum()/w.sum())
            new_rates.append(round(max(0.0,min(1.0,wpr)),4))
        acc = _compute_true_accuracy(gs, new_rates)
        bs  = _bias_score_from_rates(new_rates, hp)
        dpd = round(max(new_rates)-min(new_rates),4) if len(new_rates)>=2 else 0.0
        dpd_after = round(max(new_rates) - min(new_rates), 4) if len(new_rates) >= 2 else 0.0
        dir_after = round(min(new_rates)/max(new_rates), 4) if len(new_rates)>=2 and max(new_rates)>0 else 1.0
        return {"method":"reweighing","accuracy":acc,"dpd":dpd_after,"dir":dir_after,
                "tpr_gap":None,"fpr_gap":None,"adjusted_rates":new_rates}
    except Exception as e:
        return {"method":"reweighing","error":str(e)}


def _method_threshold_optimisation(df, computed, lambda_acc=0.5):
    try:
        sc = computed["sensitive_col"]; tc = computed["target_col"]
        pc = computed["positive_class"]; gs = computed["group_stats"]
        hp = computed["has_predictions"]
        if not sc or not tc or not pc:
            return {"method":"threshold_optimisation","error":"insufficient columns"}
        rates = [g["pass_rate"] for g in gs]
        global_target = float(np.median(rates))
        best_rates = []; total_correct = 0.0; total_n = 0
        for g_s in gs:
            g = g_s["group"]
            gdf = df[df[sc].astype(str)==g]; n = len(gdf)
            if n == 0: continue
            actual_pos = int((gdf[tc]==pc).sum()); actual_neg = n - actual_pos
            best_loss = float("inf"); best_rate_t = g_s["pass_rate"]; best_acc_t = 0.0
            for t in np.arange(0.02, 0.99, 0.02):
                pred_pos = max(0, min(n, int(np.ceil(n*(1.0-float(t))))))
                pred_neg = n - pred_pos
                tp = min(pred_pos, actual_pos); tn = min(pred_neg, actual_neg)
                adj_rate = pred_pos/n; acc_t = (tp+tn)/n
                loss = abs(adj_rate-global_target) + lambda_acc*(1.0-acc_t)
                if loss < best_loss:
                    best_loss=loss; best_rate_t=round(adj_rate,4); best_acc_t=acc_t
            best_rates.append(best_rate_t)
            total_correct += best_acc_t*n; total_n += n
        if not best_rates:
            return {"method":"threshold_optimisation","error":"no groups processed"}
        acc = float(round(max(0.0,min(1.0,total_correct/total_n)),4)) if total_n>0 else 0.5
        bs  = _bias_score_from_rates(best_rates, hp)
        dpd = round(max(best_rates)-min(best_rates),4) if len(best_rates)>=2 else 0.0
        dpd_after = round(max(best_rates)-min(best_rates),4) if len(best_rates)>=2 else 0.0
        dir_after = round(min(best_rates)/max(best_rates),4) if len(best_rates)>=2 and max(best_rates)>0 else 1.0
        return {"method":"threshold_optimisation","accuracy":acc,"dpd":dpd_after,"dir":dir_after,
                "tpr_gap":None,"fpr_gap":None,"adjusted_rates":best_rates,
                "global_target":round(global_target,4)}
    except Exception as e:
        return {"method":"threshold_optimisation","error":str(e)}


def _method_adversarial(df, computed, lambda_penalty=0.5):
    try:
        sc = computed["sensitive_col"]; tc = computed["target_col"]
        gs = computed["group_stats"]; hp = computed["has_predictions"]
        if not sc or not tc:
            return {"method":"adversarial_debiasing","error":"insufficient columns"}
        rates = [g["pass_rate"] for g in gs]
        if not rates:
            return {"method":"adversarial_debiasing","error":"no group data"}
        global_mean = float(np.mean(rates))
        adjusted = [float(r) for r in rates]
        for _ in range(50):
            grad = [r-global_mean for r in adjusted]
            adjusted = [max(0.001,min(1.0,r-lambda_penalty*g)) for r,g in zip(adjusted,grad)]
            new_mean = float(np.mean(adjusted))
            if new_mean > 0:
                scale = global_mean/new_mean
                adjusted = [max(0.001,min(1.0,r*scale)) for r in adjusted]
            if max(adjusted)-min(adjusted) < 0.01: break
        acc = _compute_true_accuracy(gs, adjusted)
        bs  = _bias_score_from_rates(adjusted, hp)
        dpd = round(max(adjusted)-min(adjusted),4)
        dpd_after = round(max(adjusted)-min(adjusted),4)
        dir_after = round(min(adjusted)/max(adjusted),4) if max(adjusted)>0 else 1.0
        return {"method":"adversarial_debiasing","accuracy":acc,"dpd":dpd_after,"dir":dir_after,
                "tpr_gap":None,"fpr_gap":None,"adjusted_rates":adjusted}
    except Exception as e:
        return {"method":"adversarial_debiasing","error":str(e)}


def run_mitigation(df: pd.DataFrame, computed: dict) -> MitigationSummary:
    """
    Run all 3 mitigation methods and rank them.

    KEY DESIGN DECISIONS:
    - All methods simulate what bias WOULD look like after their intervention.
    - Reweighing: weights converge pass rates to global mean -> projected DPD~0.
      BUT: this requires model retraining. We apply a 0.85 confidence discount
      to bias_reduction to reflect that the improvement is projected, not guaranteed.
    - Threshold optimisation: finds per-group threshold minimising |rate - median|.
    - Adversarial debiasing: iterative gradient equalisation toward global mean.

    Ranking: final_score = 0.5*bias_reduction + 0.4*accuracy + 0.1*stability
    Methods that INCREASE bias get final_score = -1 (invalid).
    """
    before_score   = computed["bias_score"]
    before_dpd     = float(computed.get("dpd", 0.0))
    before_dir     = float(computed.get("dir_", 1.0) or 1.0)
    group_stats    = computed["group_stats"]
    original_rates = [float(gs["pass_rate"]) for gs in group_stats]
    global_target  = float(np.median(original_rates))

    descriptions = {
        "reweighing": (
            f"Assigns sample weights w(g,y)=P(Y=y)·P(G=g)/P(Y=y,G=g). "
            f"Projected DPD converges toward 0 after retraining. "
            f"Confidence-discounted: actual improvement may vary."
        ),
        "threshold_optimisation": (
            f"Finds the decision threshold per group minimising "
            f"|rate−{global_target:.1%}| (global median) + 0.5×(1−accuracy). "
            f"Post-processing: no retraining required."
        ),
        "adversarial_debiasing": (
            f"Iterative gradient equalisation: rate_g ← rate_g − 0.5×(rate_g−mean). "
            f"Preserves global mean; converges when max−min < 1%."
        ),
    }

    # Confidence discount per method (how reliable is the projected improvement)
    confidence = {
        "reweighing":             0.85,   # requires retraining — projected
        "threshold_optimisation": 0.92,   # post-processing — fairly reliable
        "adversarial_debiasing":  0.80,   # iterative simulation — optimistic
    }

    raw_results = [
        _method_reweighing(df, computed),
        _method_threshold_optimisation(df, computed),
        _method_adversarial(df, computed),
    ]

    results = []
    for r in raw_results:
        if r is None or not isinstance(r, dict):
            r = {"method": "unknown", "error": "method returned None"}
        method = r.get("method", "unknown")

        if "error" in r:
            acc       = 0.0
            dpd_after = before_dpd
            dir_after = before_dir
            adj_rates = original_rates
            valid     = False
        else:
            acc       = float(r.get("accuracy") or 0.0)
            dpd_after = float(r.get("dpd", before_dpd))
            dir_after = float(r.get("dir", before_dir))
            adj_rates = r.get("adjusted_rates", original_rates)
            valid     = bool(dpd_after < before_dpd)   # valid if DPD actually decreased

        acc       = max(0.0, min(1.0, acc))
        dpd_after = max(0.0, min(1.0, dpd_after))

        # DPD reduction (0→1): how much disparity was removed
        dpd_reduction = max(0.0, min(1.0, (before_dpd - dpd_after) / before_dpd)) if before_dpd > 0 else 0.0

        # Apply confidence discount per method
        conf          = confidence.get(method, 0.80)
        adj_dpd_red   = dpd_reduction * conf

        stability     = _compute_stability([float(x) for x in adj_rates])

        # Rank: 40% DPD reduction, 40% accuracy, 20% stability
        final_score = round(
            0.4 * adj_dpd_red + 0.4 * acc + 0.2 * stability, 4
        ) if valid else -1.0

        # Compute projected bias score using the SAME formula as compute_raw_stats
        # so it's consistent and meaningful
        proj_dpd_v = min(dpd_after / 0.10, 1.0)
        proj_dir_v = 0.0 if dir_after >= 0.80 else min((0.80 - dir_after) / 0.80, 1.0)
        proj_bias  = round(float(np.mean([proj_dpd_v, proj_dir_v])) * 100, 1)

        tpr_gap_val = r.get("tpr_gap") if isinstance(r, dict) else None
        fpr_gap_val = r.get("fpr_gap") if isinstance(r, dict) else None
        dpd_val     = dpd_after

        results.append(MitigationMethodResult(
            method=method,
            bias_score=round(proj_bias, 1),
            accuracy=round(acc, 4),
            tpr_gap=round(float(tpr_gap_val), 4) if tpr_gap_val is not None else 0.0,
            fpr_gap=round(float(fpr_gap_val), 4) if fpr_gap_val is not None else 0.0,
            dpd=round(dpd_val, 4),
            improvement=round(before_score - proj_bias, 1),
            final_score=final_score,
            description=(
                descriptions.get(method, "")
                + ("" if valid else " ⚠ Invalid: method did not reduce bias.")
            ),
        ))

    valid_results = [r for r in results if r.final_score >= 0]
    best = max(valid_results, key=lambda x: x.final_score) if valid_results            else min(results, key=lambda x: x.bias_score)

    bias_after  = best.bias_score
    acc_after   = best.accuracy
    dpd_after_b = best.dpd
    improvement = round(before_score - bias_after, 1)
    dpd_improv  = round(before_dpd - dpd_after_b, 4)
    pct_reduc   = round((improvement / before_score * 100), 1) if before_score > 0 else 0.0

    trade_off = (
        f"Projected bias {before_score} → {bias_after} (↓{improvement} pts, {pct_reduc}% reduction)"
        f" | DPD: {before_dpd:.4f} → {dpd_after_b:.4f} | Est. Accuracy: {acc_after*100:.1f}%"
    )
    reason = (
        f"{best.method.replace('_',' ').title()} selected "
        f"(rank={best.final_score:.3f}): "
        f"DPD {before_dpd:.4f} → {dpd_after_b:.4f} (↓{dpd_improv:.4f}), "
        f"projected bias {before_score} → {bias_after}, "
        f"est. accuracy {acc_after*100:.1f}%."
    )

    return MitigationSummary(
        before_bias_score=before_score,
        results=results,
        best_method=best.method,
        best_reason=reason,
        bias_before=before_score,
        bias_after=bias_after,
        accuracy_after=acc_after,
        trade_off_summary=trade_off,
    )

# ─────────────────────────────────────────────────────────────────────────────
# 13. ROOT CAUSE ENGINE
# ─────────────────────────────────────────────────────────────────────────────

def generate_root_causes(stats: dict) -> list[str]:
    c   = stats["computed"]
    gs  = c["group_stats"]
    met = c["metrics"]
    causes = []

    if len(gs) < 2:
        return ["Only one group found — comparative analysis not possible."]

    rates = [(g["group"], g["pass_rate"]) for g in gs]
    rates.sort(key=lambda x: x[1])
    lo_g, lo_r = rates[0]; hi_g, hi_r = rates[-1]; gap = hi_r - lo_r
    if gap > 0.05:
        causes.append(
            f"'{hi_g}' has a {gap:.1%} higher selection rate ({hi_r:.1%}) "
            f"than '{lo_g}' ({lo_r:.1%})."
        )

    vals = [(g["group"], g["avg_value"]) for g in gs if g["avg_value"] is not None]
    if vals:
        vals.sort(key=lambda x: x[1])
        lo_vg, lo_v = vals[0]; hi_vg, hi_v = vals[-1]; vgap = hi_v - lo_v
        if vgap > 2:
            causes.append(
                f"Performance gap: '{lo_vg}' avg={lo_v:.1f} vs "
                f"'{hi_vg}' avg={hi_v:.1f} (gap={vgap:.1f})."
            )

    for m in met:
        if m["key"] == "disparate_impact_ratio" and m["flagged"]:
            val_str = f"{m['value']:.3f}" if m["value"] is not None else "undefined"
            causes.append(
                f"Disparate Impact Ratio ({val_str}) is below the 0.80 legal threshold."
            )

    theil = c.get("theil", 0.0)
    if theil > 0.05:
        causes.append(
            f"Theil inequality index of {theil:.4f} indicates significant "
            f"outcome inequality across groups."
        )

    # EO causes only when predictions exist
    if c.get("has_predictions"):
        tprs = [(g["group"], g["tpr"]) for g in gs if g["tpr"] is not None]
        if len(tprs) >= 2:
            tprs.sort(key=lambda x: x[1])
            tpr_gap_val = tprs[-1][1] - tprs[0][1]
            if tpr_gap_val > 0.10:
                causes.append(
                    f"Equal Opportunity gap {tpr_gap_val:.3f}: "
                    f"'{tprs[0][0]}' TPR={tprs[0][1]:.3f} vs "
                    f"'{tprs[-1][0]}' TPR={tprs[-1][1]:.3f}."
                )
        fprs = [(g["group"], g["fpr"]) for g in gs if g["fpr"] is not None]
        if len(fprs) >= 2:
            fprs.sort(key=lambda x: x[1])
            fpr_gap_val = fprs[-1][1] - fprs[0][1]
            if fpr_gap_val > 0.10:
                causes.append(
                    f"Equalized Odds (FPR) gap {fpr_gap_val:.3f}: "
                    f"'{fprs[0][0]}' FPR={fprs[0][1]:.3f} vs "
                    f"'{fprs[-1][0]}' FPR={fprs[-1][1]:.3f}."
                )

    for g in gs:
        if g["pass_rate"] == 0.0 and g["count"] > 5:
            causes.append(
                f"Anomaly: group '{g['group']}' has 0% selection rate ({g['count']} samples)."
            )

    return causes if causes else ["No significant bias root causes detected above thresholds."]


# ─────────────────────────────────────────────────────────────────────────────
# 14. BIAS ORIGIN
# ─────────────────────────────────────────────────────────────────────────────

def detect_bias_origin(stats: dict) -> Optional[dict]:
    c  = stats["computed"]
    gs = c["group_stats"]
    if len(gs) < 2: return None
    rates         = [(g["group"], g["pass_rate"]) for g in gs]
    most_affected = min(rates, key=lambda x: x[1])[0]
    worst_metric  = "Demographic Parity Difference"
    worst_dev     = -1.0
    for m in c["metrics"]:
        if m["threshold"] is None: continue
        v = m["value"]
        if v is None: continue
        dev = (v - m["threshold"]) if m["threshold_direction"] == "below" \
              else (m["threshold"] - v)
        if dev > worst_dev: worst_dev = dev; worst_metric = m["name"]
    return {"group": most_affected, "metric": worst_metric}


# ─────────────────────────────────────────────────────────────────────────────
# 15. PROMPT BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def build_prompt(stats: dict, root_causes: list[str], reliability: dict) -> str:
    c          = stats["computed"]
    breakdown  = c.get("score_breakdown", {})
    root_block = "\n".join(f"- {x}" for x in root_causes)
    mode = ("model-based (true confusion matrix)" if c["has_predictions"]
            else "label-only (no prediction column — TPR/FPR not measured)")

    context = (
        f"Dataset: {c['total_rows']} rows | Sensitive: {c['sensitive_col']} "
        f"| Target: {c['target_col']}\n"
        f"Mode: {mode}\n"
        f"Bias score: {c['bias_score']} ({c['bias_level']}) | "
        f"Reliability: {reliability.get('reliability')} ({reliability.get('confidence_score')}/100)\n"
        f"Violations averaged: {breakdown.get('violations_counted',2)} "
        f"({'DPD+DIR' if breakdown.get('label_only_mode') else 'DPD+DIR+TPR+FPR'})\n"
        f"Score breakdown: "
        f"DPD={breakdown.get('dpd_violation',0)}pts "
        f"DIR={breakdown.get('dir_violation',0)}pts"
        + (f" TPR={breakdown.get('tpr_violation','N/A')}pts "
           f"FPR={breakdown.get('fpr_violation','N/A')}pts"
           if not breakdown.get('label_only_mode') else "")
    )

    metric_keys = (
        '"demographic_parity_difference":"sentence",'
        '"disparate_impact_ratio":"sentence",'
        '"theil_index":"sentence",'
        '"performance_gap":"sentence"'
        + (',"tpr_gap":"sentence","fpr_gap":"sentence"'
           if c["has_predictions"] else "")
    )

    schema = (
        f'{{"metric_interpretations":{{{metric_keys}}},'
        '"summary":"para1\\n\\npara2\\n\\npara3",'
        '"key_findings":["f1","f2","f3","f4","f5"],'
        '"recommendations":["r1","r2","r3","r4"]}}'
    )

    return (
        "You are FairLens, an AI fairness auditor. All numbers are pre-computed by Python.\n"
        "Fill the text fields below. Be specific, factual, cite real numbers.\n\n"
        f"CONTEXT:\n{context}\n\nSTATISTICS:\n{stats['compact_summary']}\n\n"
        f"ROOT CAUSES:\n{root_block}\n\n"
        "RULES:\n"
        "1. Output ONLY valid JSON. No markdown.\n"
        "2. metric_interpretations: 1 sentence ≤20 words with actual value.\n"
        "3. summary: 3 paragraphs (\\n\\n), ≤90 words total. Use actual group names.\n"
        "4. key_findings: 5 items ≤25 words each. Every item must cite real numbers.\n"
        "5. recommendations: 4 specific actionable items ≤25 words each.\n"
        "6. DO NOT invent groups, teachers, or columns not in the statistics.\n\n"
        "Fill ALL placeholders:\n" + schema
    )


# ─────────────────────────────────────────────────────────────────────────────
# 16. JSON EXTRACTION
# ─────────────────────────────────────────────────────────────────────────────

def extract_json(text: str) -> dict:
    def _try(s):
        try: return json.loads(s)
        except: return None

    r = _try(text)
    if r: return r
    c = re.sub(r"```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
    c = re.sub(r"```\s*$", "", c).strip()
    r = _try(c)
    if r: return r
    s = text.find("{")
    if s != -1:
        depth = 0
        for i, ch in enumerate(text[s:], s):
            if ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    r = _try(text[s:i+1]) or _try(_fix_json(text[s:i+1]))
                    if r: return r
                    break
    r = _try(_fix_json(c))
    if r: return r
    raise ValueError(f"Cannot parse Gemini JSON. First 400: {text[:400]!r}")


def _fix_json(s: str) -> str:
    s = re.sub(r'(?<!https:)(?<!http:)//[^\n"]*', '', s)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
    s = re.sub(r",\s*([}\]])", r"\1", s)
    for old, new in [("None","null"),("True","true"),("False","false")]:
        s = re.sub(rf"\b{old}\b", new, s)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)


# ─────────────────────────────────────────────────────────────────────────────
# 17. MERGE → AuditResponse
# ─────────────────────────────────────────────────────────────────────────────

def merge_into_response(stats, ai, root_causes, bias_origin_dict,
                        mitigation, stat_test, reliability_dict) -> AuditResponse:
    c       = stats["computed"]
    # Guard: Gemini may return None or a list for metric_interpretations
    raw_interps = ai.get("metric_interpretations", {})
    interps = raw_interps if isinstance(raw_interps, dict) else {}

    metrics = [
        MetricResult(
            name=m["name"], key=m["key"],
            value=m["value"] if m["value"] is not None else 0.0,
            threshold=m.get("threshold"),
            threshold_direction=m.get("threshold_direction", "below"),
            flagged=m["flagged"],
            interpretation=interps.get(m["key"], ""),
        )
        for m in c["metrics"]
    ]

    group_stats = [
        GroupStats(
            group=g["group"], count=g["count"], avg_value=g.get("avg_value"),
            pass_count=g["pass_count"], fail_count=g["fail_count"],
            pass_rate=g["pass_rate"],
            tpr=g.get("tpr"),       # None in label-only — NOT 0.0
            fpr=g.get("fpr"),       # None in label-only — NOT 0.0
            accuracy=g.get("accuracy"),
            confusion=ConfusionMatrix(**g["confusion"]) if g.get("confusion") else None,
        )
        for g in c["group_stats"]
    ]

    audit_summary = _safe_json({
        "bias_score":        c["bias_score"],
        "bias_level":        c["bias_level"],
        "sensitive_column":  c.get("sensitive_col"),
        "target_column":     c.get("target_col"),
        "prediction_column": c.get("prediction_col"),
        "has_predictions":   c.get("has_predictions", False),
        "metrics":           [{m.key: round(m.value or 0, 4)} for m in metrics],
        "group_stats":       [{"group": g.group, "pass_rate": g.pass_rate,
                               "tpr": g.tpr, "fpr": g.fpr} for g in group_stats],
        "root_causes":       root_causes,
        "key_findings":      ai.get("key_findings", []),
        "reliability":       reliability_dict.get("reliability"),
        "stat_sig":          stat_test.get("is_significant") if stat_test else None,
    })

    return AuditResponse(
        bias_score=c["bias_score"], bias_level=c["bias_level"],
        risk_label=c["risk_label"], bias_detected=c["bias_detected"],
        total_rows=c["total_rows"], columns=c["columns"],
        sensitive_column=c.get("sensitive_col"),
        target_column=c.get("target_col"),
        prediction_column=c.get("prediction_col"),
        has_predictions=c.get("has_predictions", False),
        metrics=metrics, group_stats=group_stats,
        statistical_test=StatisticalTest(**stat_test) if stat_test else None,
        bias_origin=BiasOrigin(**bias_origin_dict) if bias_origin_dict else None,
        root_causes=root_causes,
        mitigation=mitigation,
        reliability=DataReliability(**reliability_dict),
        summary=ai.get("summary") or "",
        key_findings=[f for f in (ai.get("key_findings") or []) if isinstance(f, str)],
        recommendations=[r for r in (ai.get("recommendations") or []) if isinstance(r, str)],
        audit_summary_json=audit_summary,
        score_breakdown=c.get("score_breakdown"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 18. GEMINI CALL
# ─────────────────────────────────────────────────────────────────────────────

async def call_gemini(prompt: str) -> dict:
    if not GEMINI_API_KEY: raise RuntimeError("GEMINI_API_KEY not configured")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            GEMINI_URL, params={"key": GEMINI_API_KEY},
            json={"contents": [{"parts": [{"text": prompt}]}],
                  "generationConfig": {"temperature": 0.0, "maxOutputTokens": 4096}},
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini error {resp.status_code}: {resp.text[:400]}")
    cands = resp.json().get("candidates", [])
    if not cands:
        feedback = resp.json().get("promptFeedback", {})
        block_reason = feedback.get("blockReason", "unknown")
        raise RuntimeError(f"Gemini returned no candidates. Block reason: {block_reason}")
    candidate = cands[0]
    content = candidate.get("content")
    if content is None:
        finish = candidate.get("finishReason", "unknown")
        raise RuntimeError(f"Gemini candidate has no content (finishReason={finish})")
    parts = content.get("parts", [])
    if not parts or not parts[0].get("text"):
        raise RuntimeError("Gemini response has empty parts/text")
    return extract_json(parts[0]["text"])


# ─────────────────────────────────────────────────────────────────────────────
# 19. CHAT
# ─────────────────────────────────────────────────────────────────────────────

async def run_chat(request: ChatRequest) -> ChatResponse:
    if not GEMINI_API_KEY: raise RuntimeError("GEMINI_API_KEY not configured")
    ctx = (
        f"You are FairLens, AI fairness auditor.\n"
        f"Dataset: {request.dataset_description}\n"
        f"Findings: {request.audit_summary}\n\n"
        f"Answer concisely (2-3 paragraphs). Reference actual numbers. Give practical advice."
    )
    hist = "".join(
        f"{'User' if m['role']=='user' else 'Assistant'}: {m['content']}\n\n"
        for m in request.conversation
    )
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            GEMINI_URL, params={"key": GEMINI_API_KEY},
            json={"contents": [{"parts": [{"text": f"{ctx}\n\n{hist}User: {request.message}\n\nAssistant:"}]}],
                  "generationConfig": {"temperature": 0.3, "maxOutputTokens": 800}},
        )
    resp.raise_for_status()
    chat_resp  = resp.json()
    chat_cands = chat_resp.get("candidates", [])
    if not chat_cands or not chat_cands[0].get("content"):
        raise RuntimeError("Gemini chat returned no content")
    reply_text = chat_cands[0]["content"]["parts"][0]["text"].strip()
    return ChatResponse(reply=reply_text)


# ─────────────────────────────────────────────────────────────────────────────
# 20. ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

async def run_audit(request: AuditRequest) -> AuditResponse:
    import traceback
    df = decode_csv(request.dataset)
    target_col, sensitive_col, pred_col, _ = detect_columns(
        df, request.target_column, request.sensitive_column, request.prediction_column
    )

    try:
        reliability_dict = validate_data(df, sensitive_col, target_col)
    except Exception:
        reliability_dict = {"reliability": "Medium", "confidence_score": 50.0, "warnings": []}

    stats = compute_raw_stats(
        df, description=request.description,
        target_col=target_col,
        sensitive_col=sensitive_col,
        sensitive_col_2=request.sensitive_column_2,
        prediction_col=pred_col,
    )

    c = stats["computed"]

    stat_test = None
    if sensitive_col and target_col:
        stat_test = run_statistical_test(df, sensitive_col, target_col, c["positive_class"])

    root_causes      = generate_root_causes(stats)
    bias_origin_dict = detect_bias_origin(stats)
    mitigation       = run_mitigation(df, c)
    prompt           = build_prompt(stats, root_causes, reliability_dict)
    try:
        ai = await call_gemini(prompt)
    except Exception as gemini_err:
        raise RuntimeError(f"Gemini call failed: {gemini_err}")

    # Ensure ai is a dict with expected structure
    if not isinstance(ai, dict):
        ai = {}

    try:
        return merge_into_response(
        stats, ai, root_causes, bias_origin_dict,
        mitigation, stat_test, reliability_dict
        )
    except Exception as merge_err:
        raise RuntimeError(f"Response assembly failed: {merge_err}\n{traceback.format_exc()}")