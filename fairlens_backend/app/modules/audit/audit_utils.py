"""
audit_utils.py — Full fairness metrics, bias flags, risk scoring, mitigation.
"""

import base64
import io
import numpy as np
import pandas as pd
from sklearn.preprocessing import LabelEncoder

MAX_FILE_BYTES = 5 * 1024 * 1024
MIN_ROWS = 50

BIAS_THRESHOLDS = {
    "demographic_parity_difference": 0.10,
    "equalized_odds_difference": 0.10,
    "disparate_impact_ratio": 0.80,
    "accuracy_parity_difference": 0.05,
    "selection_rate_difference": 0.10,
}

METRIC_WEIGHTS = {
    "demographic_parity_difference": 30,
    "equalized_odds_difference": 25,
    "disparate_impact_ratio": 25,
    "accuracy_parity_difference": 10,
    "selection_rate_difference": 10,
}


# ── CSV helpers ───────────────────────────────────────────────────────────────

def decode_csv(base64_str: str) -> pd.DataFrame:
    try:
        if "," in base64_str and base64_str.startswith("data:"):
            base64_str = base64_str.split(",", 1)[1]
        raw_bytes = base64.b64decode(base64_str)
        if len(raw_bytes) > MAX_FILE_BYTES:
            raise ValueError("File too large. Maximum 5MB.")
        return pd.read_csv(io.BytesIO(raw_bytes))
    except (base64.binascii.Error, UnicodeDecodeError) as e:
        raise ValueError(f"Could not decode CSV: {e}")
    except pd.errors.ParserError as e:
        raise ValueError(f"Invalid CSV format: {e}")


def validate_columns(df, target_col, sensitive_col, sensitive_col_2=None):
    if len(df) < MIN_ROWS:
        raise ValueError(f"Dataset too small ({len(df)} rows). Minimum {MIN_ROWS}.")
    cols = [target_col, sensitive_col] + ([sensitive_col_2] if sensitive_col_2 else [])
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(f"Columns not found: {missing}")
    if target_col == sensitive_col:
        raise ValueError("Target and sensitive columns must be different.")


def encode_dataframe_csv(df: pd.DataFrame) -> str:
    """Encode a DataFrame as base64 CSV string."""
    buf = io.BytesIO()
    df.to_csv(buf, index=False)
    return base64.b64encode(buf.getvalue()).decode()


def encode_model(model) -> str:
    import joblib
    buf = io.BytesIO()
    joblib.dump(model, buf)
    return base64.b64encode(buf.getvalue()).decode()


def build_debiased_dataset(
    df_original: pd.DataFrame,
    target_col: str,
    sensitive_col: str,
    sensitive_col_2: str = None,
    random_state: int = 42,
) -> pd.DataFrame:
    """
    Produces a genuinely debiased dataset by physically rebalancing rows.

    Strategy:
    1. Compute the target selection rate = overall mean of target across all groups
    2. For each (sensitive_group, target_label) cell:
       - If the cell is underrepresented → oversample with replacement
       - If overrepresented → undersample
    3. Result: every group has approximately the same positive selection rate
    4. Removes fairlens_sample_weight column if present
    5. Shuffles rows so the CSV looks natural

    When you re-upload this CSV to FairLens, the model trains on balanced data
    and the fairness scores should be genuinely low.
    """
    rng = np.random.RandomState(random_state)

    df = df_original.copy()

    # Drop internal weight column if present from previous export
    df = df.drop(columns=["fairlens_sample_weight"], errors="ignore")

    # Build the sensitive column (may be intersectional)
    if sensitive_col_2 and sensitive_col_2 in df.columns:
        sensitive = df[sensitive_col].astype(str) + "_" + df[sensitive_col_2].astype(str)
    else:
        sensitive = df[sensitive_col].astype(str)

    # Encode target temporarily for computation
    target = df[target_col]
    if target.dtype == object or str(target.dtype) == "category":
        le = LabelEncoder()
        target_enc = pd.Series(le.fit_transform(target), index=df.index)
    else:
        target_enc = target.astype(int)

    groups = sensitive.unique()
    labels = target_enc.unique()

    n_total = len(df)
    n_groups = len(groups)
    n_labels = len(labels)

    # Target count per (group, label) cell = equal representation
    # Each cell should have: n_total / (n_groups * n_labels) rows
    target_per_cell = int(round(n_total / (n_groups * n_labels)))
    # Minimum cell size to avoid tiny datasets
    target_per_cell = max(target_per_cell, 20)

    resampled_parts = []

    for g in groups:
        for label in labels:
            mask = (sensitive == g) & (target_enc == label)
            cell_df = df[mask]
            n_cell = len(cell_df)

            if n_cell == 0:
                continue

            if n_cell < target_per_cell:
                # Oversample: repeat rows with replacement to hit target
                extra_needed = target_per_cell - n_cell
                extra = cell_df.sample(n=extra_needed, replace=True, random_state=rng)
                resampled_parts.append(pd.concat([cell_df, extra], ignore_index=True))
            else:
                # Undersample: randomly drop rows down to target
                resampled_parts.append(
                    cell_df.sample(n=target_per_cell, replace=False, random_state=rng)
                )

    if not resampled_parts:
        return df

    result = pd.concat(resampled_parts, ignore_index=True)

    # Shuffle so rows aren't grouped by (group, label)
    result = result.sample(frac=1, random_state=rng).reset_index(drop=True)

    # Add a metadata column so user knows this is debiased
    result["fairlens_debiased"] = True

    return result


# ── Preprocessing ─────────────────────────────────────────────────────────────

def preprocess(df, target_col, sensitive_col, sensitive_col_2=None):
    df = df.copy()

    # Drop FairLens internal columns before training
    df = df.drop(columns=["fairlens_sample_weight", "fairlens_debiased"], errors="ignore")

    cols_needed = [target_col, sensitive_col] + ([sensitive_col_2] if sensitive_col_2 else [])
    df = df.dropna(subset=cols_needed)

    y_raw = df[target_col]
    if y_raw.dtype == object or str(y_raw.dtype) == "category":
        le = LabelEncoder()
        y = pd.Series(le.fit_transform(y_raw), index=df.index)
    else:
        y = y_raw.astype(int)

    if sensitive_col_2:
        sensitive = df[sensitive_col].astype(str) + "_" + df[sensitive_col_2].astype(str)
    else:
        sensitive = df[sensitive_col].astype(str)

    feature_cols = [c for c in df.columns if c != target_col]
    X = df[feature_cols].copy()

    for col in X.columns:
        if X[col].dtype == object or str(X[col].dtype) == "category":
            X[col] = X[col].fillna(X[col].mode()[0] if not X[col].mode().empty else "unknown")
        else:
            X[col] = X[col].fillna(X[col].median())

    label_encoders = {}
    for col in X.select_dtypes(include=["object", "category"]).columns:
        le = LabelEncoder()
        X[col] = le.fit_transform(X[col].astype(str))
        label_encoders[col] = le

    return X, y, sensitive, list(feature_cols), label_encoders


def get_sensitive_encoded(sensitive):
    le = LabelEncoder()
    return pd.Series(le.fit_transform(sensitive), index=sensitive.index)


# ── Per-group metrics ─────────────────────────────────────────────────────────

def _safe_div(a, b, fallback=0.0):
    return a / b if b != 0 else fallback


def compute_group_metrics(y_true, y_pred, sensitive):
    if isinstance(y_true, pd.Series):
        y_true = y_true.values
    if isinstance(y_pred, pd.Series):
        y_pred = y_pred.values

    results = {}
    for group in sorted(sensitive.unique(), key=str):
        mask = sensitive == group
        yt = y_true[mask.values]
        yp = y_pred[mask.values]
        n = len(yt)
        if n == 0:
            continue

        tp = int(np.sum((yt == 1) & (yp == 1)))
        tn = int(np.sum((yt == 0) & (yp == 0)))
        fp = int(np.sum((yt == 0) & (yp == 1)))
        fn = int(np.sum((yt == 1) & (yp == 0)))

        results[str(group)] = {
            "count": n,
            "positive_count": int(tp + fn),
            "selection_rate": round(float(np.mean(yp == 1)), 4),
            "accuracy": round(_safe_div(tp + tn, n), 4),
            "tpr": round(_safe_div(tp, tp + fn), 4),
            "fpr": round(_safe_div(fp, fp + tn), 4),
            "precision": round(_safe_div(tp, tp + fp), 4),
        }
    return results


def compute_fairness_metrics(y_true, y_pred, sensitive):
    group_metrics = compute_group_metrics(y_true, y_pred, sensitive)
    if len(group_metrics) < 2:
        return {}

    selection_rates = {g: m["selection_rate"] for g, m in group_metrics.items()}
    accuracies = {g: m["accuracy"] for g, m in group_metrics.items()}
    tprs = {g: m["tpr"] for g, m in group_metrics.items()}
    fprs = {g: m["fpr"] for g, m in group_metrics.items()}

    max_sr = max(selection_rates.values())
    min_sr = min(selection_rates.values())
    dp_diff = max_sr - min_sr
    tpr_diff = max(tprs.values()) - min(tprs.values())
    fpr_diff = max(fprs.values()) - min(fprs.values())
    eo_diff = max(tpr_diff, fpr_diff)
    di_ratio = _safe_div(min_sr, max_sr, fallback=1.0)
    acc_diff = max(accuracies.values()) - min(accuracies.values())

    return {
        "demographic_parity_difference": round(dp_diff, 4),
        "equalized_odds_difference": round(eo_diff, 4),
        "disparate_impact_ratio": round(di_ratio, 4),
        "accuracy_parity_difference": round(acc_diff, 4),
        "selection_rate_difference": round(dp_diff, 4),
    }


def detect_bias_flags(fairness_metrics):
    flags = {}
    for metric, value in fairness_metrics.items():
        threshold = BIAS_THRESHOLDS.get(metric)
        if threshold is None:
            continue
        if metric == "disparate_impact_ratio":
            flags[metric] = value < threshold
        else:
            flags[metric] = abs(value) > threshold
    return flags


def compute_risk_score(fairness_metrics):
    if not fairness_metrics:
        return 0.0, "Low"
    flags = detect_bias_flags(fairness_metrics)
    score = sum(METRIC_WEIGHTS.get(m, 10) for m, f in flags.items() if f)
    score = min(100.0, score)
    label = "High" if score >= 50 else "Medium" if score >= 25 else "Low"
    return round(score, 1), label


def fairness_score_to_percent(fairness_metrics):
    dp = fairness_metrics.get("demographic_parity_difference", 0)
    return round(max(0.0, (1.0 - abs(dp)) * 100), 2)


def determine_bias_level(risk_score):
    if risk_score >= 50:
        return "High"
    elif risk_score >= 25:
        return "Moderate"
    return "Low"


# ── Mitigation ────────────────────────────────────────────────────────────────

def compute_reweighting(y_train, sens_train):
    combined = pd.DataFrame({"y": y_train.values, "s": sens_train.values})
    n = len(combined)
    n_groups = combined.groupby(["s", "y"]).size()
    total_groups = len(n_groups)
    weights = np.ones(n)
    for (s, label), count in n_groups.items():
        mask = (combined["s"] == s) & (combined["y"] == label)
        weights[mask.values] = n / (total_groups * count)
    weights = weights / weights.sum() * n
    return weights


def threshold_optimizer(y_true, y_prob, sensitive):
    groups = np.unique(sensitive)
    thresholds = {}
    for g in groups:
        mask = sensitive == g
        yp = y_prob[mask]
        best_t, best_score = 0.5, float("inf")
        for t in np.arange(0.1, 0.91, 0.05):
            sr = np.mean(yp >= t)
            score = abs(sr - 0.5)
            if score < best_score:
                best_score = score
                best_t = t
        thresholds[str(g)] = round(float(best_t), 2)
    return thresholds


def apply_thresholds(y_prob, sensitive, thresholds):
    y_pred = np.zeros(len(y_prob), dtype=int)
    for g, t in thresholds.items():
        mask = sensitive == g
        y_pred[mask] = (y_prob[mask] >= t).astype(int)
    return y_pred
