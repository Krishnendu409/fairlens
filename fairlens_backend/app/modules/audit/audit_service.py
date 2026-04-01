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

import asyncio
import logging
import os, json, re, ssl
from typing import Optional, Tuple
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
from app.modules.audit.audit_utils import (
    compute_integrity_hash,
    decode_csv,
)
from app.modules.audit.compliance_engine import evaluate_eu_ai_act
from app.modules.audit.compliance_store import JSONStorageManager

load_dotenv()
logger = logging.getLogger(__name__)

DPD_THRESHOLD = 0.10
IMBALANCE_HIGH_THRESHOLD = 0.35
DEFAULT_REPAIR_LEVEL = 0.60
ROC_UNCERTAIN_LOWER_THRESHOLD = 0.40
ROC_UNCERTAIN_UPPER_THRESHOLD = 0.60
# Small deterministic tie-breaker (3%) used only when method scores are close,
# so scenario-prioritized methods remain preferred without overpowering evidence.
SCENARIO_SELECTION_BONUS = 0.03
MIN_AUDIT_ROWS = 30
MAX_CHAT_TURNS = 10
MAX_STORED_DESCRIPTION_CHARS = 2000
HIGH_CARD_LIMIT = 20
PII_COLUMN_KEYWORDS = {"name", "email", "phone", "mobile", "address", "ssn", "dob", "birth", "passport"}

DOMAIN_SCENARIO_KEYWORDS = {
    "hr_employment": {
        "employment", "hiring", "recruitment", "hr", "applicant", "candidate", "promotion", "workforce", "salary"
    },
    "finance_credit": {
        "finance", "financial", "loan", "credit", "bank", "mortgage", "underwriting", "insurance", "premium"
    },
    "healthcare": {
        "health", "healthcare", "medical", "hospital", "patient", "diagnosis", "clinical", "triage", "treatment"
    },
    "education": {
        "education", "school", "student", "admission", "university", "college", "exam", "grade", "scholarship"
    },
    "justice_public_safety": {
        "justice", "criminal", "police", "court", "recidivism", "bail", "sentencing", "risk assessment", "public safety"
    },
    "sports_selection": {
        "sport", "sports", "athlete", "player", "team", "draft", "selection", "coach", "scouting"
    },
}

DOMAIN_METHOD_POLICY = {
    "hr_employment": "reweighing",
    "finance_credit": "threshold_optimisation",
    "healthcare": "reject_option_classification",
    "education": "reweighing",
    "justice_public_safety": "reject_option_classification",
    "sports_selection": "threshold_optimisation",
    "general": "reweighing",
}

DOMAIN_POLICY_MATRIX = {
    "hr_employment": {
        "harm_type": "allocation",
        "fairness_priority": ["demographic_parity", "disparate_impact"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["reweighing", "threshold_optimisation", "disparate_impact_remover", "reject_option_classification"],
        "caveats": "Selection and promotion decisions should minimise allocation disparity and preserve explainability.",
        "references": ["EU Charter Art. 21", "EU AI Act Art. 10", "EEOC UGESP 4/5 rule"],
    },
    "finance_credit": {
        "harm_type": "allocation",
        "fairness_priority": ["disparate_impact", "equal_opportunity"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["threshold_optimisation", "reweighing", "disparate_impact_remover", "reject_option_classification"],
        "caveats": "Credit access decisions require balancing parity constraints with calibration and denial-error control.",
        "references": ["ECOA/FHA disparate impact doctrine", "EU AI Act Art. 9/10", "80% rule practice"],
    },
    "healthcare": {
        "harm_type": "quality_of_service",
        "fairness_priority": ["equal_opportunity", "equalized_odds"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["reject_option_classification", "threshold_optimisation", "reweighing", "disparate_impact_remover"],
        "caveats": "Clinical triage should reduce error-rate disparities and avoid under-serving high-risk groups.",
        "references": ["WHO ethics guidance", "EU AI Act Art. 9", "equalized odds literature"],
    },
    "education": {
        "harm_type": "allocation",
        "fairness_priority": ["demographic_parity", "equal_opportunity"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["reweighing", "threshold_optimisation", "disparate_impact_remover", "reject_option_classification"],
        "caveats": "Admissions and scholarship allocation should mitigate historic exclusion while maintaining consistency.",
        "references": ["EU Charter Art. 14/21", "OECD AI fairness principles"],
    },
    "justice_public_safety": {
        "harm_type": "quality_of_service",
        "fairness_priority": ["equalized_odds", "equal_opportunity"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["reject_option_classification", "threshold_optimisation", "reweighing", "disparate_impact_remover"],
        "caveats": "Public-safety risk systems should prioritize error-rate parity to reduce harmful false positives/negatives.",
        "references": ["EU AI Act high-risk regime", "FAT/ML justice guidance", "equalized odds literature"],
    },
    "sports_selection": {
        "harm_type": "allocation",
        "fairness_priority": ["demographic_parity", "disparate_impact"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["threshold_optimisation", "reweighing", "disparate_impact_remover", "reject_option_classification"],
        "caveats": "Selection trials should minimise access disparity while preserving valid performance signals.",
        "references": ["IOC inclusion guidance", "80% rule practice"],
    },
    "general": {
        "harm_type": "allocation",
        "fairness_priority": ["demographic_parity", "disparate_impact"],
        "metric_thresholds": {"dpd_max": 0.10, "dir_min": 0.80, "tpr_gap_max": 0.10, "fpr_gap_max": 0.10},
        "mitigation_priority": ["reweighing", "threshold_optimisation", "disparate_impact_remover", "reject_option_classification"],
        "caveats": "Use conservative parity-first defaults when domain evidence is weak.",
        "references": ["EU AI Act Art. 9/10", "OECD AI Principles"],
    },
}

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


def _sanitize_description_for_storage(description: str, columns: list[str]) -> str:
    text = (description or "")[:MAX_STORED_DESCRIPTION_CHARS]
    redacted = text
    for col in columns:
        col_norm = str(col or "").strip()
        if not col_norm:
            continue
        lower_col = col_norm.lower()
        if any(keyword in lower_col for keyword in PII_COLUMN_KEYWORDS):
            redacted = re.sub(rf"\b{re.escape(col_norm)}\b", "[redacted_column]", redacted, flags=re.IGNORECASE)
    return redacted


def _build_gemini_url() -> str:
    """
    Gemini endpoint is configurable to avoid TLS hostname issues when traffic is
    routed through a proxy. Prefer full override via GEMINI_API_URL; fallback to
    GEMINI_BASE_URL + GEMINI_MODEL.
    """
    override = os.getenv("GEMINI_API_URL")
    if override:
        return override

    base = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/models/")
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    base = base.rstrip("/")

    # If caller already provided the full path (including :generateContent) keep it.
    if base.endswith(":generateContent"):
        return base

    return f"{base}/{model}:generateContent"


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = _build_gemini_url()


def _unwrap_ssl_error(exc: Exception) -> Optional[ssl.SSLCertVerificationError]:
    """
    Walk the exception chain to detect SSL cert verification failures.
    """
    seen = set()
    cur = exc
    while cur and id(cur) not in seen:
        if isinstance(cur, ssl.SSLCertVerificationError):
            return cur
        seen.add(id(cur))
        cur = getattr(cur, "__cause__", None) or getattr(cur, "__context__", None)
    return None


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
                      prediction_col: Optional[str] = None,
                      resolve_columns: bool = True) -> dict:

    if resolve_columns:
        target_col, sensitive_col, prediction_col, numeric_col = \
            detect_columns(df, target_col, sensitive_col, prediction_col)
    else:
        _, _, _, numeric_col = detect_columns(df, target_col, sensitive_col, prediction_col)

    has_predictions = bool(prediction_col and prediction_col in df.columns)

    positive_class = negative_class = None
    if target_col and target_col in df.columns:
        positive_class = detect_positive_class(df, target_col)
        for v in df[target_col].dropna().unique():
            if v != positive_class:
                negative_class = v
                break

    # ── All numeric feature columns (for avg_by_col and gap analysis) ────────
    _id_patterns = {"id", "index", "row", "num", "no", "number", "sno", "serial"}
    _reserved    = {c for c in (target_col, sensitive_col, prediction_col) if c}
    all_numeric_cols = [
        c for c in df.columns
        if pd.api.types.is_numeric_dtype(df[c])
        and c.lower().strip() not in _id_patterns
        and df[c].nunique() > 2
        and df[c].nunique() < len(df)
        and c not in _reserved
    ]

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

            # Per-column averages for all numeric feature columns
            avg_by_col: dict = {}
            for nc in all_numeric_cols:
                try:
                    v = gdf[nc].mean()
                    avg_by_col[nc] = round(float(v), 2) if not pd.isna(v) else None
                except Exception:
                    avg_by_col[nc] = None

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
                "avg_by_col": avg_by_col if avg_by_col else None,
                "pass_count": pass_ct, "fail_count": fail_ct, "pass_rate": pass_rate,
                "tpr": tpr, "fpr": fpr, "accuracy": accuracy, "confusion": cm,
            })

    # ── Group rates map (group → pass_rate) for counterfactual editor ────────
    group_rates_map = {g["group"]: g["pass_rate"] for g in group_stats}

    # ── Sample rows for counterfactual editor (first 20 rows) ────────────────
    try:
        _sample_rows = json.loads(df.head(20).to_json(orient="records"))
    except Exception:
        _sample_rows = []

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

    # ── Per-column numeric gap analysis ──────────────────────────────────────
    all_numeric_gaps: list[dict] = []
    for nc in all_numeric_cols:
        try:
            col_avgs: dict = {}
            for gs_item in group_stats:
                ab = gs_item.get("avg_by_col") or {}
                v  = ab.get(nc)
                if v is not None:
                    col_avgs[gs_item["group"]] = v
            if len(col_avgs) < 2:
                continue
            lo_grp = min(col_avgs, key=col_avgs.get)
            hi_grp = max(col_avgs, key=col_avgs.get)
            lo_val = col_avgs[lo_grp]
            hi_val = col_avgs[hi_grp]
            raw_gap = hi_val - lo_val
            col_min = float(df[nc].min())
            col_max = float(df[nc].max())
            col_range = col_max - col_min
            gap_pct = round((raw_gap / col_range) * 100, 1) if col_range > 0 else 0.0
            all_numeric_gaps.append({
                "col":      nc,
                "gap_pct":  gap_pct,
                "gap_raw":  round(float(raw_gap), 2),
                "lo_group": lo_grp,
                "lo_avg":   round(float(lo_val), 2),
                "hi_group": hi_grp,
                "hi_avg":   round(float(hi_val), 2),
                "avgs":     {k: round(float(v), 2) for k, v in col_avgs.items()},
            })
        except Exception:
            continue

    # Primary numeric column is the one with the largest gap (or the first detected)
    primary_numeric_column: Optional[str] = numeric_col
    if all_numeric_gaps:
        primary_numeric_column = max(all_numeric_gaps, key=lambda x: x["gap_pct"])["col"]

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
            "tpr_gap":        tpr_gap,
            "fpr_gap":        fpr_gap,
            "avg_gap":        avg_gap,
            "theil":          theil,
            "score_breakdown": score_breakdown,
            "positive_class": positive_class if positive_class is not None else None,
            "negative_class": negative_class if negative_class is not None else None,
            "all_numeric_gaps":        all_numeric_gaps,
            "primary_numeric_column":  primary_numeric_column,
            "sample_rows":             _sample_rows,
            "group_rates_map":         group_rates_map,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. STATISTICAL SIGNIFICANCE
# ─────────────────────────────────────────────────────────────────────────────

def run_statistical_test(df: pd.DataFrame, sensitive_col: str,
                         target_col: str, positive_class) -> dict:
    try:
        work = df[[sensitive_col, target_col]].dropna()
        contingency = pd.crosstab(work[sensitive_col], work[target_col])
        if contingency.shape[0] < 2 or contingency.shape[1] < 2:
            return {
                "test": "chi_square",
                "statistic": 0.0,
                "p_value": 1.0,
                "is_significant": False,
                "interpretation": "Not enough group/outcome variation to run chi-square test.",
                "cramers_v": None,
                "effect_size": None,
            }

        # Pearson chi-square test of independence (without Yates correction).
        chi2, p, dof, _ = scipy_stats.chi2_contingency(contingency, correction=False)
        sig = bool(p < 0.05)
        n = int(contingency.values.sum())
        r, k = contingency.shape

        # Bias-corrected Cramer's V (Bergsma, 2013) for more stable effect size,
        # especially in smaller samples and non-square contingency tables.
        if n > 1:
            phi2 = float(chi2) / float(n)
            # Finite-sample bias correction for phi^2.
            phi2_corr = max(0.0, phi2 - ((k - 1) * (r - 1)) / float(n - 1))
            # Corrected effective table dimensions (rows/columns).
            rows_corrected = r - ((r - 1) ** 2) / float(n - 1)
            cols_corrected = k - ((k - 1) ** 2) / float(n - 1)
            denom = min(cols_corrected - 1, rows_corrected - 1)
            cramers_v = round(float(np.sqrt(phi2_corr / denom)), 4) if denom > 0 else 0.0
        else:
            cramers_v = None

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
            "interpretation": f"χ²={chi2:.3f}, p={p:.4f}, dof={dof}.",
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
    dpd, dir_ = _compute_dpd_dir_from_rates(rates_f)
    dpd_v = min(dpd / 0.10, 1.0)
    dir_v = (0.0 if dir_ is not None and dir_ >= 0.80
             else (min((0.80 - dir_) / 0.80, 1.0) if dir_ is not None else 1.0))
    violations = [dpd_v, dir_v]
    if has_pred and tpr_list and fpr_list and len(tpr_list) >= 2 and len(fpr_list) >= 2:
        tpr_g = max(tpr_list) - min(tpr_list)
        fpr_g = max(fpr_list) - min(fpr_list)
        violations += [min(tpr_g / 0.10, 1.0), min(fpr_g / 0.10, 1.0)]
    return float(round(float(np.mean(violations)) * 100, 1))


def _compute_dpd_dir_from_rates(rates: list[float]) -> tuple[float, Optional[float]]:
    if len(rates) < 2:
        return 0.0, 1.0
    dpd = round(float(max(rates) - min(rates)), 4)
    max_r = float(max(rates))
    if max_r > 0:
        return dpd, round(float(min(rates) / max_r), 4)
    return dpd, None


def _compute_expected_accuracy(group_stats: list, adjusted_rates: list) -> float:
    """
    Expected accuracy estimate under independence assumption:
      acc_g = P(pred=1)*P(y=1) + P(pred=0)*P(y=0)
    where P(pred=1) is the adjusted group rate and P(y=1) is observed prevalence.
    This avoids optimistic oracle-style assignment and stays in [0, 1].
    """
    total_expected_correct = 0.0
    total_n       = 0
    for gs, adj_rate in zip(group_stats, adjusted_rates):
        n = int(gs.get("count", 0))
        if n <= 0:
            continue
        base_pos = float(gs.get("pass_rate", 0.0))
        base_neg = 1.0 - base_pos
        pred_pos = max(0.0, min(1.0, float(adj_rate)))
        pred_neg = 1.0 - pred_pos
        expected_acc = (pred_pos * base_pos) + (pred_neg * base_neg)
        total_expected_correct += expected_acc * n
        total_n       += n
    if total_n == 0:
        return 0.0
    return float(round(max(0.0, min(1.0, total_expected_correct / total_n)), 4))


def _compute_stability(adjusted_rates: list) -> float:
    """Stability = 1 - std(rates). Higher = more equal groups. Always [0,1]."""
    if len(adjusted_rates) < 2:
        return 1.0
    return float(round(max(0.0, min(1.0, 1.0 - float(np.std(adjusted_rates)))), 4))


def _compute_tpr_fpr_gaps(y_true: np.ndarray, y_pred: np.ndarray, sensitive: pd.Series) -> Tuple[Optional[float], Optional[float]]:
    tpr_vals = []
    fpr_vals = []
    sensitive_str = sensitive.astype(str)
    # Stable deterministic ordering for reporting and reproducibility.
    # Lexicographic ordering is intentional for mixed/string group labels.
    unique_groups = sorted(sensitive_str.unique())
    for grp in unique_groups:
        mask = sensitive_str == str(grp)
        if int(mask.sum()) == 0:
            continue
        yt = np.array(y_true[mask], dtype=int)
        yp = np.array(y_pred[mask], dtype=int)
        tp = int(np.sum((yt == 1) & (yp == 1)))
        fp = int(np.sum((yt == 0) & (yp == 1)))
        fn = int(np.sum((yt == 1) & (yp == 0)))
        tn = int(np.sum((yt == 0) & (yp == 0)))
        if (tp + fn) > 0:
            tpr_vals.append(float(tp / (tp + fn)))
        if (fp + tn) > 0:
            fpr_vals.append(float(fp / (fp + tn)))
    tpr_gap = round(float(max(tpr_vals) - min(tpr_vals)), 4) if len(tpr_vals) >= 2 else None
    fpr_gap = round(float(max(fpr_vals) - min(fpr_vals)), 4) if len(fpr_vals) >= 2 else None
    return tpr_gap, fpr_gap


def _binary_pr(y_true, y_pred) -> tuple[float, float]:
    y_t = np.array(y_true, dtype=int)
    y_p = np.array(y_pred, dtype=int)
    tp = int(np.sum((y_t == 1) & (y_p == 1)))
    fp = int(np.sum((y_t == 0) & (y_p == 1)))
    fn = int(np.sum((y_t == 1) & (y_p == 0)))
    precision = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
    recall = float(tp / (tp + fn)) if (tp + fn) > 0 else 0.0
    return (round(precision, 4), round(recall, 4))


def _compute_dataset_imbalance(y_bin: np.ndarray) -> float:
    if len(y_bin) == 0:
        return 0.0
    pos = int(np.sum(y_bin == 1))
    neg = int(np.sum(y_bin == 0))
    maj = max(pos, neg)
    minc = min(pos, neg)
    if maj == 0:
        return 0.0
    return round(float((maj - minc) / maj), 4)


def _infer_dataset_domain_scenario(
    df: pd.DataFrame,
    computed: dict,
    dataset_description: Optional[str] = None,
) -> tuple[str, float, list[str]]:
    description_text = str(dataset_description or "").lower()
    column_text = " ".join([str(c).lower() for c in df.columns])
    sensitive_col = str(computed.get("sensitive_col") or "").lower()
    target_col = str(computed.get("target_col") or "").lower()
    corpus = f"{description_text} {column_text} {sensitive_col} {target_col}"

    scores = {}
    evidence = {}
    for scenario, keywords in DOMAIN_SCENARIO_KEYWORDS.items():
        hits = sorted([kw for kw in keywords if kw in corpus])
        scores[scenario] = len(hits)
        evidence[scenario] = hits

    best_scenario = "general"
    best_hits = 0
    for scenario, score in scores.items():
        if score > best_hits:
            best_scenario = scenario
            best_hits = score

    if best_hits == 0:
        return "general", 0.0, []
    confidence = round(min(1.0, best_hits / 3.0), 2)
    return best_scenario, confidence, evidence.get(best_scenario, [])


def _scenario_aware_method_selection(
    df: pd.DataFrame,
    computed: dict,
    dataset_description: Optional[str] = None,
) -> tuple[str, str, dict]:
    dpd = float(computed.get("dpd", 0.0))
    dir_ = computed.get("dir_", 1.0)
    dir_val = float(dir_) if dir_ is not None else 0.0
    group_stats = computed.get("group_stats", [])
    rates = [float(g.get("pass_rate", 0.0)) for g in group_stats]
    selection_rate_spread = round(max(rates) - min(rates), 4) if len(rates) >= 2 else 0.0
    sensitive_col = computed.get("sensitive_col")

    tc = computed.get("target_col")
    pc = computed.get("positive_class")
    imbalance = 0.0
    if tc and tc in df.columns and pc is not None:
        y_bin = (df[tc] == pc).astype(int).to_numpy()
        imbalance = _compute_dataset_imbalance(y_bin)

    scenario, scenario_confidence, scenario_evidence = _infer_dataset_domain_scenario(
        df, computed, dataset_description
    )
    selected_method = DOMAIN_METHOD_POLICY.get(scenario, "reweighing")
    policy_profile = DOMAIN_POLICY_MATRIX.get(scenario, DOMAIN_POLICY_MATRIX["general"])
    reason = (
        f"Dataset domain scenario '{scenario}' detected "
        f"(confidence={scenario_confidence:.2f}) using dataset description/columns; "
        f"{selected_method.replace('_', ' ')} is prioritized by domain mitigation policy."
    )

    context = {
        "protected_attribute": sensitive_col,
        "selection_rate_spread": selection_rate_spread,
        "dpd": round(dpd, 4),
        "dir": round(dir_val, 4),
        "dataset_imbalance": imbalance,
        "has_predictions": bool(computed.get("has_predictions", False)),
        "scenario": scenario,
        "scenario_confidence": scenario_confidence,
        "scenario_evidence": scenario_evidence,
        "scenario_source": "dataset_description_and_columns",
        "policy_profile": policy_profile,
    }
    return selected_method, reason, context


def _metric_override_selection(
    *,
    computed: dict,
    policy_profile: dict,
    policy_selected_method: str,
) -> tuple[str, Optional[str], dict]:
    dpd = float(computed.get("dpd", 0.0))
    dir_raw = computed.get("dir_", None)
    dir_val = float(dir_raw) if dir_raw is not None else None
    tpr_gap = computed.get("tpr_gap")
    fpr_gap = computed.get("fpr_gap")
    has_predictions = bool(computed.get("has_predictions", False))
    thresholds = policy_profile.get("metric_thresholds", {})

    gates = {
        "dpd_severe": dpd > max(float(thresholds.get("dpd_max", 0.10)) * 1.5, 0.15),
        "dir_critical": (dir_val is not None and dir_val < min(float(thresholds.get("dir_min", 0.80)) - 0.10, 0.70)),
        "tpr_gap_severe": bool(has_predictions and tpr_gap is not None and float(tpr_gap) > max(float(thresholds.get("tpr_gap_max", 0.10)) * 1.5, 0.15)),
        "fpr_gap_severe": bool(has_predictions and fpr_gap is not None and float(fpr_gap) > max(float(thresholds.get("fpr_gap_max", 0.10)) * 1.5, 0.15)),
    }

    override_method = None
    override_reason = None
    if gates["tpr_gap_severe"] or gates["fpr_gap_severe"]:
        override_method = "reject_option_classification"
        override_reason = "Metric gate override: severe TPR/FPR gap prioritizes error-rate parity."
    elif gates["dpd_severe"] and not gates["dir_critical"]:
        override_method = "threshold_optimisation"
        override_reason = "Metric gate override: severe DPD requires stronger threshold balancing."
    elif gates["dir_critical"]:
        override_method = "disparate_impact_remover"
        override_reason = "Metric gate override: critical DIR violation prioritizes disparate impact repair."

    final_method = override_method or policy_selected_method
    return final_method, override_reason, {
        "metric_triggers": gates,
        "override_applied": bool(override_method is not None),
        "override_method": override_method,
        "override_reason": override_reason,
    }


def _project_trade_off_note(before_dpd: float, after_dpd: float, before_acc: Optional[float], after_acc: Optional[float]) -> str:
    if after_dpd < before_dpd:
        fair_dir = "improved"
    elif after_dpd > before_dpd:
        fair_dir = "did not improve"
    else:
        fair_dir = "remained stable"
    if before_acc is None or after_acc is None:
        return f"Fairness {fair_dir} under DPD; accuracy trade-off could not be estimated from available signals."
    delta = round((after_acc - before_acc) * 100, 2)
    if delta >= 0:
        return f"Fairness {fair_dir} under DPD while estimated accuracy changed by +{delta:.2f} points."
    return f"Fairness {fair_dir} under DPD with an estimated accuracy decrease of {abs(delta):.2f} points."


def _scenario_weighted_bias_score(
    *,
    dpd: float,
    dir_: Optional[float],
    tpr_gap: Optional[float],
    fpr_gap: Optional[float],
    has_predictions: bool,
    scenario: Optional[str],
) -> float:
    """
    Scenario-aware projected bias score:
    - uses the same normalized violation functions as compute_raw_stats
    - adjusts metric weights by active bias scenario
    """
    dpd_v = min(float(dpd) / 0.10, 1.0)
    dir_v = (
        0.0
        if dir_ is not None and float(dir_) >= 0.80
        else (min((0.80 - float(dir_)) / 0.80, 1.0) if dir_ is not None else 1.0)
    )
    weighted = [(dpd_v, 1.0), (dir_v, 1.0)]

    if has_predictions and tpr_gap is not None and fpr_gap is not None:
        tpr_v = min(float(tpr_gap) / 0.10, 1.0)
        fpr_v = min(float(fpr_gap) / 0.10, 1.0)
        weighted.extend([(tpr_v, 1.0), (fpr_v, 1.0)])

    if scenario == "high_imbalance":
        weighted = [
            (v, 1.6 if idx in (0, 1) else w)
            for idx, (v, w) in enumerate(weighted)
        ]
    elif scenario == "hr_employment":
        weighted = [
            (v, 1.8 if idx == 0 else (1.2 if idx == 1 else w))
            for idx, (v, w) in enumerate(weighted)
        ]
    elif scenario == "finance_credit":
        weighted = [
            (v, 1.4 if idx == 1 else (1.2 if idx == 0 else w))
            for idx, (v, w) in enumerate(weighted)
        ]
    elif scenario in {"healthcare", "justice_public_safety"} and len(weighted) > 2:
        weighted = [
            (v, 1.4 if idx >= 2 else w)
            for idx, (v, w) in enumerate(weighted)
        ]
    elif scenario in {"education", "sports_selection"}:
        weighted = [
            (v, 1.5 if idx == 0 else (1.1 if idx == 1 else w))
            for idx, (v, w) in enumerate(weighted)
        ]

    total_weight = float(sum(w for _, w in weighted))
    if total_weight <= 0:
        return 0.0
    weighted_mean = float(sum(v * w for v, w in weighted) / total_weight)
    return round(max(0.0, min(100.0, weighted_mean * 100.0)), 1)


# ─────────────────────────────────────────────────────────────────────────────
# 9. MITIGATION METHOD 1 — REWEIGHING
# ─────────────────────────────────────────────────────────────────────────────


def _method_reweighing(df, computed):
    try:
        sc = computed["sensitive_col"]; tc = computed["target_col"]
        pc = computed["positive_class"]; gs = computed["group_stats"]
        if not sc or not tc or pc is None:
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
        acc = _compute_expected_accuracy(gs, new_rates)
        # bias score recomputed below from dpd/dir after adjustment — _bias_score_from_rates not used here
        dpd_after, dir_after = _compute_dpd_dir_from_rates(new_rates)
        return {"method":"reweighing","method_type":"pre-processing","accuracy":acc,"precision":None,"recall":None,"dpd":dpd_after,"dir":dir_after,
                "tpr_gap":None,"fpr_gap":None,"adjusted_rates":new_rates}
    except (ValueError, KeyError, pd.errors.MergeError) as e:
        return {"method":"reweighing","error":str(e)}
    except Exception:
        logger.exception("Unexpected error in reweighing mitigation")
        return {"method":"reweighing","error":"Internal error — see server logs"}


def _method_threshold_optimisation(df, computed, lambda_acc=0.5):
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler

        sc = computed["sensitive_col"]; tc = computed["target_col"]
        pc = computed["positive_class"]; gs = computed["group_stats"]
        if not sc or not tc or pc is None:
            return {"method":"threshold_optimisation","error":"insufficient columns"}

        X, y, sensitive = _prepare_training_frame(df, computed)
        if X is None or y is None or sensitive is None:
            return {"method":"threshold_optimisation","error":"insufficient columns"}
        if len(np.unique(y)) < 2:
            return {"method":"threshold_optimisation","error":"target column has only one class"}

        base_model = Pipeline([
            ("scaler", StandardScaler()),
            ("lr", LogisticRegression(max_iter=1000, solver="lbfgs")),
        ])
        base_model.fit(X, y)
        y_prob = base_model.predict_proba(X)[:, 1]

        rates = [g["pass_rate"] for g in gs]
        global_target = float(np.median(rates)) if rates else 0.5
        group_thresholds = {}
        group_order = sorted(sensitive.unique(), key=str)

        for grp in group_order:
            mask = sensitive.astype(str) == str(grp)
            if int(mask.sum()) == 0:
                continue
            gp = y_prob[mask]
            gy = np.array(y[mask], dtype=int)
            best_t = 0.5
            best_loss = float("inf")
            for t in np.arange(0.02, 0.981, 0.02):
                pred = (gp >= float(t)).astype(int)
                adj_rate = float(np.mean(pred == 1))
                acc_t = float(np.mean(pred == gy))
                loss = abs(adj_rate - global_target) + lambda_acc * (1.0 - acc_t)
                if loss < best_loss:
                    best_loss = loss
                    best_t = float(t)
            group_thresholds[str(grp)] = round(best_t, 2)

        if not group_thresholds:
            return {"method":"threshold_optimisation","error":"no groups processed"}

        y_hat = np.zeros(len(y_prob), dtype=int)
        for grp, t in group_thresholds.items():
            mask = sensitive.astype(str) == str(grp)
            y_hat[mask] = (y_prob[mask] >= float(t)).astype(int)

        best_rates = []
        for grp in group_order:
            mask = sensitive.astype(str) == str(grp)
            if int(mask.sum()) == 0:
                continue
            best_rates.append(round(float(np.mean(y_hat[mask] == 1)), 4))

        acc = float(round(np.mean(y_hat == np.array(y, dtype=int)), 4))
        dpd_after, dir_after = _compute_dpd_dir_from_rates(best_rates)
        prec, rec = _binary_pr(np.array(y, dtype=int), y_hat)
        tpr_gap, fpr_gap = _compute_tpr_fpr_gaps(np.array(y, dtype=int), y_hat, sensitive)
        return {"method":"threshold_optimisation","method_type":"post-processing","accuracy":acc,"precision":prec,"recall":rec,"dpd":dpd_after,"dir":dir_after,
                "tpr_gap":tpr_gap,"fpr_gap":fpr_gap,"adjusted_rates":best_rates,
                "global_target":round(global_target,4)}
    except (ValueError, KeyError, pd.errors.MergeError) as e:
        return {"method":"threshold_optimisation","error":str(e)}
    except Exception:
        logger.exception("Unexpected error in threshold optimisation mitigation")
        return {"method":"threshold_optimisation","error":"Internal error — see server logs"}


def _method_disparate_impact_remover(df, computed, repair_level=DEFAULT_REPAIR_LEVEL):
    try:
        sc = computed["sensitive_col"]; tc = computed["target_col"]; pc = computed["positive_class"]
        if not sc or not tc or pc is None:
            return {"method":"disparate_impact_remover","error":"insufficient columns"}

        work = df.copy()
        work["_y_bin"] = (work[tc] == pc).astype(int)
        overall_rate = float(work["_y_bin"].mean()) if len(work) else 0.0

        adjusted_rates = []
        for grp in sorted(work[sc].dropna().unique(), key=str):
            gmask = work[sc].astype(str) == str(grp)
            if int(gmask.sum()) == 0:
                continue
            group_rate = float(work.loc[gmask, "_y_bin"].mean())
            repaired = (1.0 - repair_level) * group_rate + repair_level * overall_rate
            adjusted_rates.append(round(max(0.0, min(1.0, repaired)), 4))

        if len(adjusted_rates) < 2:
            return {"method":"disparate_impact_remover","error":"no groups processed"}

        dpd_after, dir_after = _compute_dpd_dir_from_rates(adjusted_rates)

        gs = computed.get("group_stats", [])
        acc = _compute_expected_accuracy(gs, adjusted_rates)
        prec = rec = None

        return {
            "method":"disparate_impact_remover",
            "method_type":"pre-processing",
            "accuracy":acc,
            "precision":prec,
            "recall":rec,
            "dpd":dpd_after,
            "dir":dir_after,
            "tpr_gap":None,
            "fpr_gap":None,
            "adjusted_rates":adjusted_rates,
        }
    except (ValueError, KeyError, pd.errors.MergeError) as e:
        return {"method":"disparate_impact_remover","error":str(e)}
    except Exception:
        logger.exception("Unexpected error in disparate impact remover mitigation")
        return {"method":"disparate_impact_remover","error":"Internal error — see server logs"}


def _method_reject_option_classification(df, computed):
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler

        sc = computed["sensitive_col"]; tc = computed["target_col"]; pc = computed["positive_class"]
        if not sc or not tc:
            return {"method":"reject_option_classification","error":"insufficient columns"}

        X, y, sensitive = _prepare_training_frame(df, computed)
        if X is None or y is None or sensitive is None:
            return {"method":"reject_option_classification","error":"insufficient columns"}
        if len(np.unique(y)) < 2:
            return {"method":"reject_option_classification","error":"target column has only one class"}

        model = Pipeline([
            ("scaler", StandardScaler()),
            ("lr", LogisticRegression(max_iter=1000, solver="lbfgs")),
        ])
        model.fit(X, y)
        y_prob = model.predict_proba(X)[:, 1]
        y_pred = (y_prob >= 0.5).astype(int)

        groups = sorted(sensitive.unique(), key=str)
        base_rates = {}
        for grp in groups:
            mask = sensitive.astype(str) == str(grp)
            if int(mask.sum()) == 0:
                continue
            base_rates[str(grp)] = float(np.mean(y_pred[mask] == 1))
        if len(base_rates) < 2:
            return {"method":"reject_option_classification","error":"insufficient group predictions"}

        priv = max(base_rates, key=base_rates.get)
        unpriv = min(base_rates, key=base_rates.get)

        low, high = ROC_UNCERTAIN_LOWER_THRESHOLD, ROC_UNCERTAIN_UPPER_THRESHOLD
        uncertain = (y_prob >= low) & (y_prob <= high)
        adjusted_pred = np.array(y_pred, dtype=int)
        for idx, flag in enumerate(uncertain):
            if not flag:
                continue
            grp = str(sensitive.iloc[idx])
            if grp == unpriv:
                adjusted_pred[idx] = 1
            elif grp == priv:
                adjusted_pred[idx] = 0

        adjusted_rates = []
        for grp in groups:
            mask = sensitive.astype(str) == str(grp)
            if int(mask.sum()) == 0:
                continue
            adjusted_rates.append(round(float(np.mean(adjusted_pred[mask] == 1)), 4))

        dpd_after, dir_after = _compute_dpd_dir_from_rates(adjusted_rates)
        acc = float(round(np.mean(adjusted_pred == np.array(y, dtype=int)), 4))
        prec, rec = _binary_pr(np.array(y, dtype=int), adjusted_pred)
        tpr_gap, fpr_gap = _compute_tpr_fpr_gaps(np.array(y, dtype=int), adjusted_pred, sensitive)
        return {
            "method":"reject_option_classification",
            "method_type":"post-processing",
            "accuracy":acc,
            "precision":prec,
            "recall":rec,
            "dpd":dpd_after,
            "dir":dir_after,
            "tpr_gap":tpr_gap,
            "fpr_gap":fpr_gap,
            "adjusted_rates":adjusted_rates,
        }
    except (ValueError, KeyError, pd.errors.MergeError) as e:
        return {"method":"reject_option_classification","error":str(e)}
    except Exception:
        logger.exception("Unexpected error in reject option classification mitigation")
        return {"method":"reject_option_classification","error":"Internal error — see server logs"}


def _prepare_training_frame(df: pd.DataFrame, computed: dict):
    sc = computed["sensitive_col"]
    tc = computed["target_col"]
    if not sc or not tc or sc not in df.columns or tc not in df.columns:
        return None, None, None
    train_df = df[[c for c in df.columns if c != tc]].copy()
    y_raw = df[tc].copy()
    y = (y_raw == computed.get("positive_class")).astype(int)
    sensitive = df[sc].astype(str)
    train_df = train_df.drop(columns=[sc], errors="ignore")
    cat_cols = train_df.select_dtypes(include=["object", "category"]).columns
    for col in list(cat_cols):
        if train_df[col].nunique(dropna=True) > HIGH_CARD_LIMIT:
            train_df = train_df.drop(columns=[col], errors="ignore")
    train_df = pd.get_dummies(train_df, drop_first=False)
    train_df = train_df.fillna(0)
    return train_df, y, sensitive


async def run_mitigation(
    df: pd.DataFrame,
    computed: dict,
    dataset_description: Optional[str] = None,
) -> MitigationSummary:
    """
    Scenario-aware mitigation suite:
    - Reweighing (pre-processing)
    - Disparate Impact Remover (pre-processing)
    - Threshold Optimisation (post-processing)
    - Reject Option Classification (post-processing)

    All methods are evaluated before/after. Scenario-aware logic picks a preferred
    strategy, while final recommendation still considers measured trade-offs.
    """
    before_score   = computed["bias_score"]
    before_dpd     = float(computed.get("dpd", 0.0))
    before_dir_raw = computed.get("dir_", 1.0)
    before_dir     = float(before_dir_raw) if before_dir_raw is not None else None
    group_stats    = computed["group_stats"]
    original_rates = [float(gs["pass_rate"]) for gs in group_stats]
    global_target  = float(np.median(original_rates))

    baseline_acc = None
    baseline_precision = None
    baseline_recall = None
    if computed.get("has_predictions") and computed.get("target_col") in df.columns and computed.get("prediction_col") in df.columns:
        y_true_b = (df[computed["target_col"]] == computed.get("positive_class")).astype(int).to_numpy()
        y_pred_b = (df[computed["prediction_col"]] == computed.get("positive_class")).astype(int).to_numpy()
        baseline_acc = float(round(np.mean(y_true_b == y_pred_b), 4))
        baseline_precision, baseline_recall = _binary_pr(y_true_b, y_pred_b)

    descriptions = {
        "reweighing": "Reweighing adjusts instance influence across protected groups before model fitting to reduce structural imbalance in outcomes.",
        "disparate_impact_remover": "Disparate Impact Remover repairs group-conditioned outcome distortions to reduce indirect bias patterns.",
        "threshold_optimisation": (
            f"Finds the decision threshold per group minimising "
            f"|rate−{global_target:.1%}| (global median) + 0.5×(1−accuracy) "
            f"on model-predicted probabilities."
        ),
        "reject_option_classification": "Reject Option Classification shifts uncertain boundary decisions to favor disadvantaged groups while preserving utility.",
    }

    # Confidence discount per method (how reliable is the projected improvement)
    confidence = {
        "reweighing":                    0.95,
        "disparate_impact_remover":      0.90,
        "threshold_optimisation": 0.92,
        "reject_option_classification":  0.91,
    }

    policy_selected_method, selection_reason, selection_context = _scenario_aware_method_selection(
        df, computed, dataset_description
    )
    policy_profile = selection_context.get("policy_profile", DOMAIN_POLICY_MATRIX["general"])
    selected_method, metric_override_reason, override_context = _metric_override_selection(
        computed=computed,
        policy_profile=policy_profile,
        policy_selected_method=policy_selected_method,
    )
    decision_trace = [
        {
            "layer": "scenario_policy",
            "scenario": selection_context.get("scenario"),
            "confidence": selection_context.get("scenario_confidence"),
            "evidence": selection_context.get("scenario_evidence", []),
            "policy_selected_method": policy_selected_method,
            "reason": selection_reason,
        },
        {
            "layer": "metric_gate",
            "metric_triggers": override_context.get("metric_triggers", {}),
            "override_applied": override_context.get("override_applied", False),
            "override_method": override_context.get("override_method"),
            "override_reason": override_context.get("override_reason"),
            "final_method": selected_method,
        },
    ]
    selection_context = {
        **selection_context,
        **override_context,
        "policy_selected_method": policy_selected_method,
        "final_selected_method": selected_method,
        "final_selection_source": "metric_override" if override_context.get("override_applied") else "scenario_policy",
        "decision_trace": decision_trace,
    }

    raw_results = await asyncio.gather(
        asyncio.to_thread(_method_reweighing, df, computed),
        asyncio.to_thread(_method_disparate_impact_remover, df, computed),
        asyncio.to_thread(_method_threshold_optimisation, df, computed),
        asyncio.to_thread(_method_reject_option_classification, df, computed),
    )

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
            prec      = None
            rec       = None
            method_type = "unknown"
            valid     = False
        else:
            acc       = float(r.get("accuracy") or 0.0)
            prec      = r.get("precision")
            rec       = r.get("recall")
            method_type = r.get("method_type", "unknown")
            dpd_after = float(r.get("dpd", before_dpd))
            dir_raw = r.get("dir", before_dir)
            dir_after = float(dir_raw) if dir_raw is not None else None
            adj_rates = r.get("adjusted_rates", original_rates)
            before_dir_safe = 0.0 if before_dir is None else before_dir
            after_dir_safe = 0.0 if dir_after is None else dir_after
            valid = bool(
                (dpd_after < before_dpd)
                or (dpd_after <= before_dpd and after_dir_safe > before_dir_safe)
            )

        acc       = max(0.0, min(1.0, acc))
        dpd_after = max(0.0, min(1.0, dpd_after))

        # DPD reduction (0→1): how much disparity was removed
        dpd_reduction = max(0.0, min(1.0, (before_dpd - dpd_after) / before_dpd)) if before_dpd > 0 else 0.0

        # Apply confidence discount per method
        conf          = confidence.get(method, 0.80)
        adj_dpd_red   = dpd_reduction * conf

        stability     = _compute_stability([float(x) for x in adj_rates])

        # Rank (formula): 60% fairness gain, 30% accuracy, 10% stability
        final_score = round(
            0.6 * adj_dpd_red + 0.3 * acc + 0.1 * stability, 4
        ) if valid else -1.0
        # Small deterministic tie-breaker to preserve scenario-aware preference
        # when measured method quality is otherwise near-identical.
        if method == selected_method and final_score >= 0:
            final_score = round(min(1.0, final_score + SCENARIO_SELECTION_BONUS), 4)

        tpr_gap_val = r.get("tpr_gap") if isinstance(r, dict) else None
        fpr_gap_val = r.get("fpr_gap") if isinstance(r, dict) else None
        proj_bias = _scenario_weighted_bias_score(
            dpd=dpd_after,
            dir_=dir_after,
            tpr_gap=tpr_gap_val,
            fpr_gap=fpr_gap_val,
            has_predictions=bool(computed.get("has_predictions")),
            scenario=selection_context.get("scenario"),
        )

        dpd_val     = dpd_after

        results.append(MitigationMethodResult(
            method=method,
            method_type=method_type,
            scenario_reason=selection_reason if method == selected_method else None,
            selected_by_scenario=bool(method == selected_method),
            selected_by_policy=bool(method == policy_selected_method),
            selected_by_metric_override=bool(method == selected_method and override_context.get("override_applied")),
            selection_badge=(
                "metric-overridden"
                if method == selected_method and override_context.get("override_applied")
                else ("policy-selected" if method == selected_method else None)
            ),
            bias_score=round(proj_bias, 1),
            accuracy=round(acc, 4),
            precision=round(float(prec), 4) if prec is not None else None,
            recall=round(float(rec), 4) if rec is not None else None,
            tpr_gap=round(float(tpr_gap_val), 4) if tpr_gap_val is not None else None,
            fpr_gap=round(float(fpr_gap_val), 4) if fpr_gap_val is not None else None,
            dpd=round(dpd_val, 4),
            dir=round(float(dir_after), 4) if dir_after is not None else None,
            before_dpd=round(before_dpd, 4),
            after_dpd=round(dpd_after, 4),
            before_dir=round(before_dir, 4) if before_dir is not None else None,
            after_dir=round(dir_after, 4) if dir_after is not None else None,
            before_accuracy=baseline_acc,
            after_accuracy=round(acc, 4),
            before_precision=baseline_precision,
            after_precision=round(float(prec), 4) if prec is not None else None,
            before_recall=baseline_recall,
            after_recall=round(float(rec), 4) if rec is not None else None,
            improvement=round(before_score - proj_bias, 1),
            final_score=final_score,
            description=(
                f"{descriptions.get(method, '').rstrip('.')}."
                f" {_project_trade_off_note(before_dpd, dpd_after, baseline_acc, acc)}"
                f"{'' if valid else ' ⚠ Invalid: method did not reduce bias.'}"
            ),
        ))

    valid_results = [r for r in results if r.final_score >= 0]
    selected_valid = [r for r in valid_results if r.method == selected_method]
    if selected_valid:
        best = selected_valid[0]
    else:
        best = (max(valid_results, key=lambda x: x.final_score)
                if valid_results
                else min(results, key=lambda x: x.bias_score))

    bias_after  = best.bias_score
    acc_after   = best.accuracy
    dpd_after_b = best.dpd
    improvement = round(before_score - bias_after, 1)
    dpd_improv  = round(before_dpd - dpd_after_b, 4)
    pct_reduc   = round((improvement / before_score * 100), 1) if before_score > 0 else 0.0

    fair_msg = (
        "Fairness improved under selected metrics."
        if dpd_after_b < before_dpd
        else "Fairness did not improve under selected metrics."
        if dpd_after_b > before_dpd
        else "Fairness remained stable under selected metrics."
    )
    acc_fragment = (
        f" Estimated accuracy after mitigation: {acc_after*100:.1f}%."
        if acc_after is not None
        else ""
    )
    trade_off = (
        f"Bias changed from {before_score} to {bias_after} "
        f"({'↓' if improvement >= 0 else '↑'}{abs(improvement)} pts, {abs(pct_reduc)}% magnitude). "
        f"DPD changed {before_dpd:.4f} → {dpd_after_b:.4f}; DIR tracked from "
        f"{(f'{before_dir:.4f}' if before_dir is not None else 'undefined')} to "
        f"{(f'{best.dir:.4f}' if best.dir is not None else 'undefined')}. "
        f"{acc_fragment} "
        f"{fair_msg} No method guarantees perfect fairness."
    )
    final_source = "metric override" if override_context.get("override_applied") else "scenario policy"
    source_reason = metric_override_reason if override_context.get("override_applied") else selection_reason
    reason = (
        f"{best.method.replace('_',' ').title()} selected via {final_source}. {source_reason} "
        f"(rank={best.final_score:.3f}): "
        f"DPD {before_dpd:.4f} → {dpd_after_b:.4f} (↓{dpd_improv:.4f}), "
        f"projected bias {before_score} → {bias_after}, "
        f"est. accuracy {(acc_after*100):.1f}%."
    )

    return MitigationSummary(
        before_bias_score=before_score,
        results=results,
        best_method=best.method,
        best_reason=reason,
        selected_method=selected_method,
        selection_reason=source_reason,
        selection_context=selection_context,
        policy_selected_method=policy_selected_method,
        metric_override_method=override_context.get("override_method"),
        final_selection_source=selection_context.get("final_selection_source"),
        decision_trace=decision_trace,
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
        '"plain_language":{'
        '"overall":"2-3 sentence plain-English summary of the bias findings for a non-technical reader",'
        '"demographic_parity_difference":"1 sentence plain-English explanation of this metric value",'
        '"disparate_impact_ratio":"1 sentence plain-English explanation of this metric value",'
        '"statistical_test":"1 sentence plain-English meaning of the statistical significance result"'
        '},'
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
        "3. plain_language.overall: 2-3 sentences, accessible to non-technical readers, cite key numbers.\n"
        "4. plain_language per metric: 1 plain-English sentence ≤25 words with actual value.\n"
        "5. summary: 3 paragraphs (\\n\\n), ≤90 words total. Use actual group names.\n"
        "6. key_findings: 5 items ≤25 words each. Every item must cite real numbers.\n"
        "7. recommendations: 4 specific actionable items ≤25 words each.\n"
        "8. DO NOT invent groups, teachers, or columns not in the statistics.\n\n"
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
            avg_by_col=g.get("avg_by_col"),
            pass_count=g["pass_count"], fail_count=g["fail_count"],
            pass_rate=g["pass_rate"],
            tpr=g.get("tpr"),       # None in label-only — NOT 0.0
            fpr=g.get("fpr"),       # None in label-only — NOT 0.0
            accuracy=g.get("accuracy"),
            confusion=ConfusionMatrix(**g["confusion"]) if g.get("confusion") else None,
        )
        for g in c["group_stats"]
    ]

    # plain_language: merge Gemini plain_language + metric_interpretations as fallback
    _raw_pl = ai.get("plain_language")
    plain_lang: dict = _raw_pl if isinstance(_raw_pl, dict) else {}
    # Ensure per-metric keys exist in plain_language (fall back to metric_interpretations)
    for m in metrics:
        if m.key not in plain_lang and m.interpretation:
            plain_lang[m.key] = m.interpretation

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
        plain_language=plain_lang,
        all_numeric_gaps=c.get("all_numeric_gaps", []),
        primary_numeric_column=c.get("primary_numeric_column"),
        sample_rows=c.get("sample_rows", []),
        group_rates_map=c.get("group_rates_map", {}),
        compliance={},
    )


# ─────────────────────────────────────────────────────────────────────────────
# 18. GEMINI CALL
# ─────────────────────────────────────────────────────────────────────────────

async def call_gemini(prompt: str) -> dict:
    if not GEMINI_API_KEY: raise RuntimeError("GEMINI_API_KEY not configured")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                GEMINI_URL, params={"key": GEMINI_API_KEY},
                json={"contents": [{"parts": [{"text": prompt}]}],
                      "generationConfig": {"temperature": 0.0, "maxOutputTokens": 6000}},
            )
    except httpx.TransportError as exc:
        ssl_err = _unwrap_ssl_error(exc)
        if ssl_err:
            raise RuntimeError(
                "Gemini TLS verification failed. If traffic goes through a proxy, set "
                "GEMINI_API_URL or GEMINI_BASE_URL to a host whose certificate matches."
            ) from ssl_err
        raise
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
        for m in request.conversation[-MAX_CHAT_TURNS:]
    )
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                GEMINI_URL, params={"key": GEMINI_API_KEY},
                json={"contents": [{"parts": [{"text": f"{ctx}\n\n{hist}User: {request.message}\n\nAssistant:"}]}],
                      "generationConfig": {"temperature": 0.3, "maxOutputTokens": 800}},
            )
    except httpx.TransportError as exc:
        ssl_err = _unwrap_ssl_error(exc)
        if ssl_err:
            raise RuntimeError(
                "Gemini TLS verification failed. Set GEMINI_API_URL or GEMINI_BASE_URL "
                "to a reachable host whose certificate matches."
            ) from ssl_err
        raise
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
    if len(df) < MIN_AUDIT_ROWS:
        raise ValueError(f"Dataset too small ({len(df)} rows). Minimum {MIN_AUDIT_ROWS} required.")
    target_col, sensitive_col, pred_col, _ = detect_columns(
        df, request.target_column, request.sensitive_column, request.prediction_column
    )
    if target_col and sensitive_col and target_col == sensitive_col:
        raise ValueError("Target and sensitive columns cannot be the same.")

    try:
        reliability_dict = validate_data(df, sensitive_col, target_col)
    except Exception:
        reliability_dict = {"reliability": "Medium", "confidence_score": 50.0, "warnings": []}

    safe_description = _sanitize_description_for_storage(request.description or "", list(df.columns))

    stats = compute_raw_stats(
        df, description=request.description,
        target_col=target_col,
        sensitive_col=sensitive_col,
        sensitive_col_2=request.sensitive_column_2,
        prediction_col=pred_col,
        resolve_columns=False,
    )

    c = stats["computed"]

    stat_test = None
    if sensitive_col and target_col:
        stat_test = run_statistical_test(df, sensitive_col, target_col, c["positive_class"])

    root_causes      = generate_root_causes(stats)
    bias_origin_dict = detect_bias_origin(stats)
    mitigation       = await run_mitigation(df, c, dataset_description=request.description)
    prompt           = build_prompt(stats, root_causes, reliability_dict)
    try:
        ai = await call_gemini(prompt)
    except Exception as gemini_err:
        raise RuntimeError(f"Gemini call failed: {gemini_err}")

    # Ensure ai is a dict with expected structure
    if not isinstance(ai, dict):
        ai = {}

    try:
        response = merge_into_response(
            stats, ai, root_causes, bias_origin_dict,
            mitigation, stat_test, reliability_dict,
        )
        final_compliance = evaluate_eu_ai_act(
            bias_score=c["bias_score"],
            metrics=c["metrics"],
            group_stats=c["group_stats"],
            summary=response.summary,
            key_findings=response.key_findings,
            recommendations=response.recommendations,
        )
        integrity_hash = compute_integrity_hash(
            request.dataset,
            {"bias_score": c["bias_score"], "metrics": c["metrics"], "mitigation": mitigation.model_dump()},
            final_compliance,
        )
        response.compliance = final_compliance
        response.integrity_hash = integrity_hash
        storage = JSONStorageManager()
        saved = storage.save_audit(
            input_data={
                "description": safe_description,
                "target_column": request.target_column,
                "sensitive_column": request.sensitive_column,
                "sensitive_column_2": request.sensitive_column_2,
                "prediction_column": request.prediction_column,
            },
            metrics={"bias_score": c["bias_score"], "metrics": c["metrics"], "mitigation": mitigation.model_dump()},
            compliance=final_compliance | {
                "integrity_hash": integrity_hash,
                "result": response.model_dump(),
            },
        )
        response.audit_id = saved["id"]
        return response
    except Exception as merge_err:
        raise RuntimeError(f"Response assembly failed: {merge_err}\n{traceback.format_exc()}")
