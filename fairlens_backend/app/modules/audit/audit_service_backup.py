"""
audit_service.py — Generalised AI-first fairness audit pipeline.

Works on ANY dataset: education, hiring, sports, finance, healthcare, etc.
Zero hardcoded column names or dataset assumptions.

Pipeline:
  1. decode_csv()         — base64 → DataFrame
  2. detect_columns()     — dynamically finds target / sensitive / numeric cols
  3. compute_raw_stats()  — ALL numbers in Python (metrics, equalized odds, root causes, simulation)
  4. build_prompt()       — compact text + ground-truth facts → Gemini (text fields only)
  5. call_gemini()        — Gemini writes interpretations, summary, findings, recommendations
  6. extract_json()       — robust parse with 5-layer fallback + truncation repair
  7. merge_into_response()— Python numbers + AI text → AuditResponse
"""

import os
import json
import re
import base64
import io
from typing import Optional

import numpy as np
import pandas as pd
import httpx

from app.schemas.audit_schema import (
    AuditRequest, AuditResponse,
    ChatRequest, ChatResponse,
    GroupStats, MetricResult, CategoryAnalysis,
    BiasOrigin, SimulationResult,
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)

# Keywords that identify a "positive" outcome in a target column
_POSITIVE_KW = {
    "pass", "yes", "1", "true", "hired", "approved",
    "selected", "1.0", "accept", "admitted", "promoted", "qualified",
}

# Pattern to detect ID-like columns to exclude from analysis
_ID_RE = re.compile(
    r"(^id$|_id$|applicant|player|student|employee|person|^name$|^index$)",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────────────────
# 1.  CSV DECODE
# ─────────────────────────────────────────────────────────────────────────────

def decode_csv(b64: str) -> pd.DataFrame:
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return pd.read_csv(io.BytesIO(raw))


# ─────────────────────────────────────────────────────────────────────────────
# 2.  DYNAMIC COLUMN DETECTION  — zero hardcoding
# ─────────────────────────────────────────────────────────────────────────────

def detect_columns(
    df: pd.DataFrame,
    user_target: Optional[str],
    user_sensitive: Optional[str],
) -> dict:
    """
    Identifies: target_col, sensitive_col, primary_numeric,
                sub_category_col, positive_class.
    All detection is data-driven from column names, cardinality, and value patterns.
    """
    str_cols = [
        c for c in df.columns
        if pd.api.types.is_string_dtype(df[c]) or df[c].dtype == object
    ]
    num_cols = [
        c for c in df.columns
        if pd.api.types.is_numeric_dtype(df[c])
        and not _ID_RE.search(c)
        and df[c].nunique() > 5
    ]

    # ── Target column ────────────────────────────────────────────────────────
    target_col = user_target if (user_target and user_target in df.columns) else None
    if not target_col:
        for col in str_cols:
            if _ID_RE.search(col):
                continue
            vals = {str(v).lower().strip() for v in df[col].dropna().unique()}
            if vals & _POSITIVE_KW:
                target_col = col
                break
        if not target_col:
            # Fallback: last string col with 2-3 unique values
            for col in reversed(str_cols):
                if not _ID_RE.search(col) and 2 <= df[col].nunique() <= 3:
                    target_col = col
                    break

    # ── Positive class ───────────────────────────────────────────────────────
    positive_class = None
    if target_col and target_col in df.columns:
        for v in df[target_col].dropna().unique():
            if str(v).lower().strip() in _POSITIVE_KW:
                positive_class = v
                break
        if positive_class is None:
            # Fallback: minority class (the "achieved" outcome is usually less common)
            counts = df[target_col].value_counts()
            positive_class = counts.idxmin() if len(counts) == 2 else counts.idxmax()

    # ── Sensitive column ─────────────────────────────────────────────────────
    sensitive_col = user_sensitive if (user_sensitive and user_sensitive in df.columns) else None
    if not sensitive_col:
        for col in str_cols:
            if col == target_col or _ID_RE.search(col):
                continue
            if 2 <= df[col].nunique() <= 10:
                sensitive_col = col
                break

    # ── Primary numeric column ────────────────────────────────────────────────
    # Pick the numeric column with the highest mean-difference between outcome classes
    primary_numeric = None
    if num_cols:
        if target_col and target_col in df.columns and positive_class is not None:
            best_diff, best_col = -1.0, None
            for col in num_cols:
                pos_mean = df[df[target_col] == positive_class][col].mean()
                neg_mean = df[df[target_col] != positive_class][col].mean()
                diff = abs(float(pos_mean) - float(neg_mean))
                if diff > best_diff:
                    best_diff, best_col = diff, col
            primary_numeric = best_col
        else:
            primary_numeric = num_cols[0]

    # ── Sub-category column ───────────────────────────────────────────────────
    # Like Subject, Training_Academy, Education_Level — NOT target, NOT sensitive, NOT ID
    sub_category_col = None
    for col in str_cols:
        if col in (target_col, sensitive_col) or _ID_RE.search(col):
            continue
        if 2 <= df[col].nunique() <= 20:
            sub_category_col = col
            break

    return {
        "target_col":      target_col,
        "sensitive_col":   sensitive_col,
        "positive_class":  positive_class,
        "numeric_cols":    num_cols,
        "primary_numeric": primary_numeric,
        "sub_category_col": sub_category_col,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3.  ALL NUMBERS COMPUTED IN PYTHON
# ─────────────────────────────────────────────────────────────────────────────

def compute_raw_stats(
    df: pd.DataFrame,
    description: str,
    user_target: Optional[str],
    user_sensitive: Optional[str],
    user_sensitive_2: Optional[str],
) -> dict:
    detected      = detect_columns(df, user_target, user_sensitive)
    target_col    = detected["target_col"]
    sensitive_col = detected["sensitive_col"]
    positive_class = detected["positive_class"]
    primary_num   = detected["primary_numeric"]
    sub_cat_col   = detected["sub_category_col"]

    # ── Per-group statistics ──────────────────────────────────────────────────
    group_stats: list[dict] = []

    if sensitive_col and sensitive_col in df.columns and target_col and target_col in df.columns:
        # Threshold for "qualified": median of primary numeric column
        qual_threshold = float(df[primary_num].median()) if primary_num else None

        for g in sorted(df[sensitive_col].dropna().unique(), key=str):
            gdf   = df[df[sensitive_col] == g]
            total = int(len(gdf))

            pos_ct  = int((gdf[target_col] == positive_class).sum())
            neg_ct  = total - pos_ct
            sel_rate = round(float(pos_ct / total), 4) if total > 0 else 0.0

            avg_num = round(float(gdf[primary_num].mean()), 2) if primary_num else None

            # Equalized Odds: TPR and FPR using numeric column as qualification proxy
            tpr = fpr = None
            if qual_threshold is not None:
                q_gdf  = gdf[gdf[primary_num] >= qual_threshold]
                nq_gdf = gdf[gdf[primary_num] <  qual_threshold]
                tpr = round(float((q_gdf[target_col]  == positive_class).mean()), 4) if len(q_gdf)  > 0 else None
                fpr = round(float((nq_gdf[target_col] == positive_class).mean()), 4) if len(nq_gdf) > 0 else None

            # Per sub-category average numeric
            avg_by_cat: dict = {}
            if sub_cat_col and primary_num:
                for cat in df[sub_cat_col].dropna().unique():
                    cdf = gdf[gdf[sub_cat_col] == cat]
                    if len(cdf) > 0:
                        avg_by_cat[str(cat)] = round(float(cdf[primary_num].mean()), 2)

            group_stats.append({
                "group":          str(g),
                "count":          total,
                "positive_count": pos_ct,
                "negative_count": neg_ct,
                "selection_rate": sel_rate,
                "tpr":            tpr,
                "fpr":            fpr,
                "avg_numeric":    avg_num,
                "avg_by_category": avg_by_cat if avg_by_cat else None,
            })

    # ── Fairness metrics ──────────────────────────────────────────────────────
    sel_rates = [g["selection_rate"] for g in group_stats]
    tprs      = [g["tpr"] for g in group_stats if g["tpr"] is not None]
    fprs      = [g["fpr"] for g in group_stats if g["fpr"] is not None]

    dpd  = round(max(sel_rates) - min(sel_rates), 4) if len(sel_rates) >= 2 else 0.0
    dir_ = round(min(sel_rates) / max(sel_rates), 4) if len(sel_rates) >= 2 and max(sel_rates) > 0 else 1.0
    tpr_gap = round(max(tprs) - min(tprs), 4) if len(tprs) >= 2 else 0.0
    fpr_gap = round(max(fprs) - min(fprs), 4) if len(fprs) >= 2 else 0.0

    avg_num_list = [g["avg_numeric"] for g in group_stats if g["avg_numeric"] is not None]
    avg_num_gap  = round(max(avg_num_list) - min(avg_num_list), 2) if len(avg_num_list) >= 2 else 0.0

    metrics = [
        {
            "name": "Demographic Parity Difference",
            "key":  "demographic_parity_difference",
            "value": dpd, "threshold": 0.10, "threshold_direction": "below",
            "flagged": dpd > 0.10,
        },
        {
            "name": "Disparate Impact Ratio",
            "key":  "disparate_impact_ratio",
            "value": dir_, "threshold": 0.80, "threshold_direction": "above",
            "flagged": dir_ < 0.80,
        },
        {
            "name": "TPR Gap (Equalized Odds)",
            "key":  "tpr_gap",
            "value": tpr_gap, "threshold": 0.10, "threshold_direction": "below",
            "flagged": tpr_gap > 0.10,
        },
        {
            "name": "FPR Gap (Equalized Odds)",
            "key":  "fpr_gap",
            "value": fpr_gap, "threshold": 0.10, "threshold_direction": "below",
            "flagged": fpr_gap > 0.10,
        },
        {
            "name": f"Avg {primary_num or 'Score'} Gap",
            "key":  "avg_numeric_gap",
            "value": avg_num_gap, "threshold": 5.0, "threshold_direction": "below",
            "flagged": avg_num_gap > 5.0,
        },
    ]

    # ── Normalised bias score (threshold-aware, always 0-100) ─────────────────
    dpd_score  = min(dpd  / 0.10, 1.0)
    dir_score  = 0.0 if dir_ >= 0.80 else min((0.80 - dir_) / 0.80, 1.0)
    tpr_score  = min(tpr_gap / 0.10, 1.0)
    gap_score  = min(avg_num_gap / 10.0, 1.0)
    flag_score = sum(m["flagged"] for m in metrics) / len(metrics)

    bias_score = round(
        (0.40 * dpd_score +
         0.30 * dir_score +
         0.15 * tpr_score +
         0.10 * gap_score +
         0.05 * flag_score) * 100,
        1
    )
    bias_score = max(0.0, min(100.0, bias_score))

    if bias_score < 20:
        bias_level, risk_label = "Low",      "Low Risk"
    elif bias_score < 45:
        bias_level, risk_label = "Moderate", "Moderate Risk"
    elif bias_score < 70:
        bias_level, risk_label = "High",     "High Risk"
    else:
        bias_level, risk_label = "Critical", "Critical Risk"

    # ── Sub-category analysis ─────────────────────────────────────────────────
    category_analysis: list[dict] = []
    if sub_cat_col and target_col and positive_class is not None:
        for cat in sorted(df[sub_cat_col].dropna().unique(), key=str):
            cdf     = df[df[sub_cat_col] == cat]
            sel_r   = round(float((cdf[target_col] == positive_class).mean()), 4) if len(cdf) > 0 else 0.0
            avg_n   = round(float(cdf[primary_num].mean()), 2) if primary_num and len(cdf) > 0 else None

            # Group gap within this sub-category
            cat_rates = []
            if sensitive_col and sensitive_col in df.columns:
                for gs in group_stats:
                    gcdf = cdf[cdf[sensitive_col] == gs["group"]]
                    if len(gcdf) > 0:
                        cat_rates.append(float((gcdf[target_col] == positive_class).mean()))
            gap = round(max(cat_rates) - min(cat_rates), 4) if len(cat_rates) >= 2 else 0.0

            category_analysis.append({
                "category_value":  str(cat),
                "category_column": sub_cat_col,
                "avg_numeric":     avg_n,
                "selection_rate":  sel_r,
                "flagged":         gap > 0.15,
                "group_gap":       gap,
                "bias_note":       None,   # AI fills this
            })

    # ── Root cause engine — Python-generated facts ────────────────────────────
    root_causes = _compute_root_causes(
        group_stats, metrics, category_analysis,
        detected, dpd, dir_, tpr_gap, avg_num_gap, positive_class,
    )

    # ── Bias origin ───────────────────────────────────────────────────────────
    bias_origin: Optional[dict] = None
    if group_stats:
        most_affected = min(group_stats, key=lambda g: g["selection_rate"])

        def _severity(m: dict) -> float:
            v, t = m["value"], m.get("threshold", 0.10)
            if t == 0:
                return 0.0
            return max(0.0, (v - t) / t) if m["threshold_direction"] == "below" else max(0.0, (t - v) / t)

        worst_m    = max(metrics, key=_severity)
        worst_cat  = None
        flagged_ca = [c for c in category_analysis if c["flagged"]]
        if flagged_ca:
            wc = max(flagged_ca, key=lambda c: c["group_gap"])
            worst_cat = f"{wc['category_column']}='{wc['category_value']}' (gap={wc['group_gap']:.1%})"

        bias_origin = {
            "most_affected_group":   most_affected["group"],
            "worst_metric":          worst_m["name"],
            "worst_metric_value":    round(worst_m["value"], 4),
            "most_biased_category":  worst_cat,
        }

    # ── Bias fix simulation ───────────────────────────────────────────────────
    simulation = _simulate_bias_fix(
        df, detected, bias_score, dpd,
    ) if (sensitive_col and target_col) else None

    return {
        "description": description,
        "detected":    detected,
        "computed": {
            "bias_score":   bias_score,
            "bias_level":   bias_level,
            "risk_label":   risk_label,
            "bias_detected": bias_score >= 20,
            "total_rows":   int(len(df)),
            "columns":      list(df.columns),
            "target_column":    target_col,
            "sensitive_column": sensitive_col,
            "positive_class":   str(positive_class) if positive_class is not None else None,
            "primary_numeric_column": primary_num,
            "category_column": sub_cat_col,
            "dpd":          dpd,
            "dir":          dir_,
            "tpr_gap":      tpr_gap,
            "fpr_gap":      fpr_gap,
            "avg_num_gap":  avg_num_gap,
            "metrics":         metrics,
            "group_stats":     group_stats,
            "category_analysis": category_analysis,
            "root_causes":   root_causes,
            "bias_origin":   bias_origin,
            "simulation":    simulation,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4.  ROOT CAUSE ENGINE — factual Python strings fed to Gemini as ground truth
# ─────────────────────────────────────────────────────────────────────────────

def _compute_root_causes(
    group_stats, metrics, category_analysis,
    detected, dpd, dir_, tpr_gap, avg_num_gap, positive_class,
) -> list[str]:
    causes = []
    sensitive  = detected.get("sensitive_col") or "group"
    primary_num = detected.get("primary_numeric")
    sub_cat    = detected.get("sub_category_col")
    pos_label  = str(positive_class) if positive_class else "positive outcome"

    if not group_stats:
        return ["Insufficient group data to compute root causes."]

    sorted_gs = sorted(group_stats, key=lambda g: g["selection_rate"])
    lowest  = sorted_gs[0]
    highest = sorted_gs[-1]
    rate_gap = highest["selection_rate"] - lowest["selection_rate"]

    # 1. Selection rate gap
    causes.append(
        f"'{lowest['group']}' achieves {pos_label} at {lowest['selection_rate']:.1%} "
        f"vs '{highest['group']}' at {highest['selection_rate']:.1%} "
        f"— a gap of {rate_gap:.1%}."
    )

    # 2. DPD threshold breach
    if dpd > 0.10:
        causes.append(
            f"Demographic Parity Difference is {dpd:.4f}, exceeding the 0.10 fairness threshold "
            f"— outcomes differ significantly across groups."
        )

    # 3. DIR (4/5 rule) breach
    if dir_ < 0.80:
        causes.append(
            f"Disparate Impact Ratio is {dir_:.4f}, below the legal 4/5 rule (0.80) "
            f"— '{lowest['group']}' is selected at less than 80% the rate of '{highest['group']}'."
        )

    # 4. Equalized Odds
    if tpr_gap > 0.10:
        tprs = [(g["group"], g["tpr"]) for g in group_stats if g["tpr"] is not None]
        if tprs:
            lo = min(tprs, key=lambda x: x[1])
            hi = max(tprs, key=lambda x: x[1])
            causes.append(
                f"Among qualified candidates, '{lo[0]}' is selected at {lo[1]:.1%} "
                f"vs '{hi[0]}' at {hi[1]:.1%} — Equalized Odds TPR gap is {tpr_gap:.4f}."
            )

    # 5. Average numeric gap
    if avg_num_gap > 5 and primary_num:
        num_sorted = sorted(group_stats, key=lambda g: g["avg_numeric"] or 0)
        lo_g = num_sorted[0]
        hi_g = num_sorted[-1]
        causes.append(
            f"Average {primary_num} gap: '{lo_g['group']}' averages {lo_g['avg_numeric']:.1f} "
            f"vs '{hi_g['group']}' at {hi_g['avg_numeric']:.1f} (gap = {avg_num_gap:.1f})."
        )

    # 6. Most biased sub-category
    if sub_cat and category_analysis:
        flagged = [c for c in category_analysis if c["flagged"]]
        if flagged:
            worst = max(flagged, key=lambda c: c["group_gap"])
            causes.append(
                f"Largest within-group disparity is in {sub_cat}='{worst['category_value']}': "
                f"group gap of {worst['group_gap']:.1%}."
            )
        else:
            causes.append(f"No extreme disparities found within individual {sub_cat} values.")

    # 7. Group underrepresentation
    total_rows = sum(g["count"] for g in group_stats)
    for g in group_stats:
        share = g["count"] / total_rows if total_rows > 0 else 0
        if share < 0.20:
            causes.append(
                f"Group '{g['group']}' is underrepresented ({g['count']} of {total_rows} rows, "
                f"{share:.1%}) — bias metrics may be amplified."
            )

    return causes


# ─────────────────────────────────────────────────────────────────────────────
# 5.  BIAS FIX SIMULATION
# ─────────────────────────────────────────────────────────────────────────────

def _simulate_bias_fix(
    df: pd.DataFrame,
    detected: dict,
    before_score: float,
    before_dpd: float,
) -> Optional[dict]:
    """
    Simulates outcome rebalancing: promote the top-scoring candidates from
    underrepresented groups until each group reaches the dataset-wide mean
    selection rate.  Works on a copy — never modifies the real data.
    """
    target_col    = detected["target_col"]
    sensitive_col = detected["sensitive_col"]
    pos_class     = detected["positive_class"]
    primary_num   = detected.get("primary_numeric")

    if not target_col or not sensitive_col or pos_class is None:
        return None

    try:
        sim_df       = df.copy()
        overall_rate = float((sim_df[target_col] == pos_class).mean())

        for g in sim_df[sensitive_col].dropna().unique():
            mask   = sim_df[sensitive_col] == g
            gdf    = sim_df[mask]
            g_rate = float((gdf[target_col] == pos_class).mean())

            if g_rate >= overall_rate:
                continue  # already at or above mean

            need_extra = int(round(overall_rate * len(gdf))) - int((gdf[target_col] == pos_class).sum())
            if need_extra <= 0:
                continue

            neg_idx = gdf[gdf[target_col] != pos_class].index.tolist()
            # Prioritise highest-scoring negatives (most deserving to flip)
            if primary_num and primary_num in gdf.columns:
                neg_idx = gdf.loc[neg_idx, primary_num].sort_values(ascending=False).index.tolist()

            flip_idx = neg_idx[:need_extra]
            sim_df.loc[flip_idx, target_col] = pos_class

        # Recompute DPD and DIR on simulated data
        new_rates = []
        for g in sim_df[sensitive_col].dropna().unique():
            gdf = sim_df[sim_df[sensitive_col] == g]
            if len(gdf) > 0:
                new_rates.append(float((gdf[target_col] == pos_class).mean()))

        if len(new_rates) < 2:
            return None

        new_dpd = round(max(new_rates) - min(new_rates), 4)
        new_dir = round(min(new_rates) / max(new_rates), 4) if max(new_rates) > 0 else 1.0

        # Recompute bias score (DPD+DIR components only — keeps it comparable)
        dpd_s = min(new_dpd / 0.10, 1.0)
        dir_s = 0.0 if new_dir >= 0.80 else min((0.80 - new_dir) / 0.80, 1.0)
        new_score = round((0.40 * dpd_s + 0.30 * dir_s) / 0.70 * 100, 1)
        new_score = max(0.0, min(100.0, new_score))

        improvement = round(before_score - new_score, 1)

        return {
            "strategy":     "Outcome Rebalancing — promote top-scoring candidates from each group to dataset mean rate",
            "before_score": before_score,
            "after_score":  new_score,
            "improvement":  improvement,
            "before_dpd":   before_dpd,
            "after_dpd":    new_dpd,
            "description": (
                f"By selecting additional high-scoring candidates from underrepresented groups "
                f"until each group reaches the dataset-wide {overall_rate:.1%} selection rate, "
                f"DPD drops from {before_dpd:.4f} to {new_dpd:.4f} "
                f"and the bias score improves by {improvement:.1f} points."
            ),
        }
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 6.  BUILD PROMPT — compact text, no raw JSON, ground-truth facts included
# ─────────────────────────────────────────────────────────────────────────────

def build_prompt(stats: dict) -> str:
    computed  = stats["computed"]
    detected  = stats["detected"]
    desc      = stats["description"]

    target    = detected["target_col"]      or "outcome"
    sensitive = detected["sensitive_col"]   or "group"
    pos_cls   = detected["positive_class"]  or "positive"
    num_col   = detected["primary_numeric"] or "score"
    sub_cat   = detected["sub_category_col"]

    gs_list  = computed["group_stats"]
    cat_list = computed["category_analysis"]
    metrics  = computed["metrics"]
    rc_list  = computed["root_causes"]

    # Group statistics block
    group_block = "\n".join(
        f"  {g['group']}: n={g['count']}, {pos_cls}_rate={g['selection_rate']:.2%}"
        + (f", avg_{num_col}={g['avg_numeric']:.1f}" if g.get("avg_numeric") is not None else "")
        + (f", TPR={g['tpr']:.2%}" if g.get("tpr") is not None else "")
        + (f", FPR={g['fpr']:.2%}" if g.get("fpr") is not None else "")
        for g in gs_list
    ) or "  (no group data)"

    # Metrics block
    metric_block = "\n".join(
        f"  {m['name']}: {m['value']:.4f} "
        f"({'<' if m['threshold_direction']=='below' else '>='}{m['threshold']} threshold, "
        f"{'FLAGGED' if m['flagged'] else 'OK'})"
        for m in metrics
    )

    # Sub-category block
    cat_block = ""
    if cat_list:
        cat_block = f"\nSUB-CATEGORY BREAKDOWN ({sub_cat}):\n" + "\n".join(
            f"  {c['category_value']}: rate={c['selection_rate']:.2%}, "
            f"group_gap={c['group_gap']:.2%}, {'FLAGGED' if c['flagged'] else 'ok'}"
            for c in cat_list
        )

    # Root causes (ground truth — AI must reference these)
    rc_block = "\n".join(f"  - {r}" for r in rc_list)

    # Bias origin
    bo = computed.get("bias_origin") or {}
    origin_block = ""
    if bo:
        origin_block = (
            f"\nBIAS ORIGIN:\n"
            f"  Most affected group: {bo.get('most_affected_group', 'N/A')}\n"
            f"  Worst metric: {bo.get('worst_metric', 'N/A')} = {bo.get('worst_metric_value', 0):.4f}\n"
        )
        if bo.get("most_biased_category"):
            origin_block += f"  Most biased sub-category: {bo['most_biased_category']}\n"

    # Build the JSON schema the AI must fill in
    metric_keys = [m["key"] for m in metrics]
    interp_lines = "\n".join(f'    "{k}": ""' for k in metric_keys)

    if cat_list:
        cat_entries = ",\n    ".join(
            f'{{"category_value": "{c["category_value"]}", "category_column": "{c["category_column"]}", "bias_note": ""}}'
            for c in cat_list
        )
        cat_schema = f'"category_details": [\n    {cat_entries}\n  ],'
    else:
        cat_schema = '"category_details": [],'

    schema = f"""{{
  "metric_interpretations": {{
{interp_lines}
  }},
  {cat_schema}
  "summary": "",
  "key_findings": ["", "", "", "", ""],
  "recommendations": ["", "", "", ""]
}}"""

    return (
        "You are FairLens, an AI fairness auditor.\n"
        "All numbers are pre-computed by Python. Your ONLY job: write the text fields.\n"
        "DO NOT invent numbers. DO NOT contradict the statistics below.\n"
        "If teacher/evaluator info is not in the description, write null for those fields.\n\n"
        f"DATASET DESCRIPTION:\n{desc}\n\n"
        f"TARGET OUTCOME: '{target}'  |  Positive class = '{pos_cls}'\n"
        f"SENSITIVE ATTRIBUTE: '{sensitive}'\n"
        f"PRIMARY NUMERIC COLUMN: '{num_col}'\n\n"
        f"GROUP STATISTICS:\n{group_block}\n\n"
        f"FAIRNESS METRICS:\n{metric_block}\n"
        f"{cat_block}\n"
        f"{origin_block}\n"
        f"COMPUTED ROOT CAUSES (reference these facts — do not contradict them):\n{rc_block}\n\n"
        "RULES:\n"
        "1. Return ONLY the JSON below. No markdown, no ```json fences, no extra text.\n"
        "2. Double quotes everywhere. null (not None). true/false (not True/False).\n"
        "3. No trailing commas.\n"
        "4. metric_interpretations: ONE sentence per metric, max 25 words, reference the actual value.\n"
        "5. category_details: ONE sentence bias_note per entry (or empty string if no bias).\n"
        "6. summary: EXACTLY 3 paragraphs separated by \\n\\n, total max 120 words.\n"
        "7. key_findings: EXACTLY 5 strings, each max 30 words, use actual numbers.\n"
        "8. recommendations: EXACTLY 4 strings, each max 25 words, specific and actionable.\n\n"
        "Fill in ALL the empty strings in this structure:\n"
        + schema
    )


# ─────────────────────────────────────────────────────────────────────────────
# 7.  ROBUST JSON EXTRACTION
# ─────────────────────────────────────────────────────────────────────────────

def extract_json(text: str) -> dict:
    def _try(s: str):
        try:
            return json.loads(s)
        except Exception:
            return None

    # 1. Direct parse
    r = _try(text)
    if r is not None:
        return r

    # 2. Strip markdown fences
    cleaned = re.sub(r"```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    r = _try(cleaned)
    if r is not None:
        return r

    # 3. Brace-match to find outermost { }
    start = text.find("{")
    if start != -1:
        depth = 0
        for i, ch in enumerate(text[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    cand = text[start: i + 1]
                    r = _try(cand) or _try(_fix_json(cand))
                    if r is not None:
                        return r
                    break

    # 4. Fix cleaned version
    r = _try(_fix_json(cleaned))
    if r is not None:
        return r

    # 5. Truncation repair
    for src in (text, cleaned):
        rep = _repair_truncated_json(src)
        if rep:
            r = _try(rep) or _try(_fix_json(rep))
            if r is not None:
                return r

    raise ValueError(
        f"Could not parse Gemini response as JSON. "
        f"First 400 chars: {text[:400]!r}"
    )


def _fix_json(s: str) -> str:
    s = re.sub(r'(?<!https:)(?<!http:)//[^\n"]*', '', s)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
    s = re.sub(r",\s*([}\]])", r"\1", s)
    s = re.sub(r"\bNone\b", "null", s)
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return s


def _repair_truncated_json(s: str) -> str:
    start = s.find("{")
    if start == -1:
        return ""
    s = s[start:]
    stack, in_string, escape_next, safe_positions = [], False, False, []

    for i, ch in enumerate(s):
        if escape_next:
            escape_next = False
            continue
        if in_string:
            if ch == "\\":
                escape_next = True
            elif ch == '"':
                in_string = False
                safe_positions.append(("str_close", i + 1, list(stack)))
            continue
        if ch == '"':
            in_string = True
            continue
        if ch in ("{", "["):
            stack.append(ch)
        elif ch == "}":
            if stack and stack[-1] == "{":
                stack.pop()
            safe_positions.append(("obj_close", i + 1, list(stack)))
        elif ch == "]":
            if stack and stack[-1] == "[":
                stack.pop()
            safe_positions.append(("arr_close", i + 1, list(stack)))

    if not stack:
        return s

    closers = {"[": "]", "{": "}"}
    for kind, pos, stk in reversed(safe_positions):
        after = s[pos:].lstrip()
        if kind in ("obj_close", "arr_close"):
            tail = s[:pos].rstrip().rstrip(",")
            for o in reversed(stk):
                tail += closers.get(o, "}")
            return tail
        elif kind == "str_close":
            if not after or after[0] in (",", "}", "]", "\n", "\r", " "):
                tail = s[:pos].rstrip().rstrip(",")
                for o in reversed(stk):
                    tail += closers.get(o, "}")
                return tail
    return ""


# ─────────────────────────────────────────────────────────────────────────────
# 8.  GEMINI CALL
# ─────────────────────────────────────────────────────────────────────────────

async def call_gemini(prompt: str) -> dict:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.0,
                    "maxOutputTokens": 8192,
                },
            },
        )

    if resp.status_code != 200:
        raise RuntimeError(f"Gemini API error {resp.status_code}: {resp.text[:400]}")

    candidates = resp.json().get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")

    raw = candidates[0]["content"]["parts"][0]["text"]
    return extract_json(raw)


# ─────────────────────────────────────────────────────────────────────────────
# 9.  MERGE — Python numbers + AI text → AuditResponse
# ─────────────────────────────────────────────────────────────────────────────

def merge_into_response(stats: dict, ai: dict) -> AuditResponse:
    c        = stats["computed"]
    detected = stats["detected"]
    interps  = ai.get("metric_interpretations", {})
    cat_ai   = {d["category_value"]: d for d in ai.get("category_details", []) if "category_value" in d}

    # Metrics (numbers from Python, interpretation from AI)
    metrics = [
        MetricResult(
            name=m["name"], key=m["key"], value=m["value"],
            threshold=m.get("threshold"),
            threshold_direction=m.get("threshold_direction", "below"),
            flagged=m["flagged"],
            interpretation=interps.get(m["key"], ""),
        )
        for m in c["metrics"]
    ]

    # Group stats
    group_stats = [
        GroupStats(
            group=g["group"], count=g["count"],
            positive_count=g["positive_count"], negative_count=g["negative_count"],
            selection_rate=g["selection_rate"],
            tpr=g.get("tpr"), fpr=g.get("fpr"),
            avg_numeric=g.get("avg_numeric"),
            avg_by_category=g.get("avg_by_category"),
        )
        for g in c["group_stats"]
    ]

    # Category analysis (numbers from Python, bias_note from AI)
    category_analysis = None
    if c["category_analysis"]:
        category_analysis = [
            CategoryAnalysis(
                category_value=ca["category_value"],
                category_column=ca["category_column"],
                avg_numeric=ca.get("avg_numeric"),
                selection_rate=ca["selection_rate"],
                flagged=ca["flagged"],
                group_gap=ca["group_gap"],
                bias_note=cat_ai.get(ca["category_value"], {}).get("bias_note"),
            )
            for ca in c["category_analysis"]
        ]

    # Bias origin
    bias_origin = BiasOrigin(**c["bias_origin"]) if c.get("bias_origin") else None

    # Simulation
    simulation = SimulationResult(**c["simulation"]) if c.get("simulation") else None

    # Compact JSON for chat context
    audit_summary_json = json.dumps({
        "bias_score":      c["bias_score"],
        "bias_level":      c["bias_level"],
        "target_column":   c["target_column"],
        "sensitive_column": c["sensitive_column"],
        "positive_class":  c["positive_class"],
        "metrics":  [{m.key: round(m.value, 4)} for m in metrics],
        "groups":   [{"group": g.group, "rate": g.selection_rate} for g in group_stats],
        "root_causes": c["root_causes"][:3],
        "key_findings": ai.get("key_findings", []),
    })

    return AuditResponse(
        bias_score=c["bias_score"],  bias_level=c["bias_level"],
        risk_label=c["risk_label"],  bias_detected=c["bias_detected"],
        total_rows=c["total_rows"],  columns=c["columns"],
        target_column=c["target_column"],
        sensitive_column=c["sensitive_column"],
        positive_class=c["positive_class"],
        primary_numeric_column=c["primary_numeric_column"],
        category_column=c["category_column"],
        metrics=metrics,
        group_stats=group_stats,
        category_analysis=category_analysis,
        root_causes=c["root_causes"],
        bias_origin=bias_origin,
        simulation=simulation,
        summary=ai.get("summary", ""),
        key_findings=ai.get("key_findings", []),
        recommendations=ai.get("recommendations", []),
        audit_summary_json=audit_summary_json,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 10.  CHAT
# ─────────────────────────────────────────────────────────────────────────────

async def run_chat(request: ChatRequest) -> ChatResponse:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")

    prompt = (
        "You are FairLens, an AI fairness auditor assistant.\n"
        f"Dataset description: {request.dataset_description}\n"
        f"Audit findings: {request.audit_summary}\n\n"
        "Answer questions concisely (2-3 paragraphs). "
        "Reference actual numbers from the findings. "
        "Give practical, actionable recommendations. "
        "Do NOT invent statistics not present in the findings.\n\n"
    )
    for m in request.conversation:
        role = "User" if m["role"] == "user" else "Assistant"
        prompt += f"{role}: {m['content']}\n\n"
    prompt += f"User: {request.message}\n\nAssistant:"

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 800},
            },
        )
    resp.raise_for_status()
    reply = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    return ChatResponse(reply=reply)


# ─────────────────────────────────────────────────────────────────────────────
# 11.  ENTRY POINTS
# ─────────────────────────────────────────────────────────────────────────────

async def run_audit(request: AuditRequest) -> AuditResponse:
    df    = decode_csv(request.dataset)
    stats = compute_raw_stats(
        df,
        description=request.description,
        user_target=request.target_column,
        user_sensitive=request.sensitive_column,
        user_sensitive_2=request.sensitive_column_2,
    )
    ai = await call_gemini(build_prompt(stats))
    return merge_into_response(stats, ai)
