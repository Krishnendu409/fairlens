"""
audit_service.py — AI-first audit pipeline.

Architecture:
  1. Decode CSV
  2. compute_raw_stats()  — ALL numbers computed in Python (groups, metrics, subjects)
  3. build_prompt()       — sends a COMPACT plain-text summary (not raw JSON dump)
                            so Gemini only writes text fields, not numbers
  4. call_gemini()        — asks for a small, well-defined JSON
  5. merge_stats_with_ai()— merge Python numbers with AI text → AuditResponse
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
    AuditRequest, AuditResponse, ChatRequest, ChatResponse,
    GroupStats, MetricResult, SubjectAnalysis,
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
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
# 2.  ALL NUMBER-CRUNCHING IN PYTHON — nothing sent raw to Gemini
# ─────────────────────────────────────────────────────────────────────────────

def compute_raw_stats(
    df: pd.DataFrame,
    description: str,
    target_col: Optional[str],
    sensitive_col: Optional[str],
    sensitive_col_2: Optional[str],
) -> dict:
    """
    Returns a dict with ALL computed numbers.
    Values are plain Python ints/floats (no numpy) so they JSON-serialise cleanly.
    """
    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    marks_col = numeric_cols[0] if numeric_cols else None   # e.g. "Marks"

    # ── Detect positive class ────────────────────────────────────────────────
    positive_class = None
    if target_col and target_col in df.columns:
        pos_kw = {"pass", "yes", "1", "true", "hired", "approved", "selected", "1.0"}
        for tv in df[target_col].dropna().unique():
            if str(tv).lower().strip() in pos_kw:
                positive_class = tv
                break
        if positive_class is None:
            positive_class = df[target_col].value_counts().idxmax()

    # ── Subject column detection ─────────────────────────────────────────────
    sub_col = next((c for c in df.columns if c.lower() in
                    {"subject", "course", "department", "category"}), None)

    # ── Grade column detection ────────────────────────────────────────────────
    grade_col = next((c for c in df.columns if c.lower() in
                      {"grade", "year", "class", "level"}), None)

    # ── Per-group stats ──────────────────────────────────────────────────────
    group_stats: list[dict] = []
    if sensitive_col and sensitive_col in df.columns:
        for g in sorted(df[sensitive_col].dropna().unique(), key=str):
            gdf = df[df[sensitive_col] == g]
            total = int(len(gdf))
            pass_ct = fail_ct = 0
            pass_rate = 0.0
            if target_col and target_col in df.columns and positive_class is not None:
                pass_ct = int((gdf[target_col] == positive_class).sum())
                fail_ct = total - pass_ct
                pass_rate = round(float(pass_ct / total), 4) if total > 0 else 0.0

            avg_marks = None
            if marks_col:
                avg_marks = round(float(gdf[marks_col].mean()), 2)

            # avg marks per subject within this group
            avg_by_subject: dict = {}
            if sub_col:
                for s in df[sub_col].dropna().unique():
                    sdf = gdf[gdf[sub_col] == s]
                    if marks_col and len(sdf) > 0:
                        avg_by_subject[str(s)] = round(float(sdf[marks_col].mean()), 2)

            group_stats.append({
                "group": str(g),
                "count": total,
                "avg_marks": avg_marks,
                "pass_count": pass_ct,
                "fail_count": fail_ct,
                "pass_rate": pass_rate,
                "avg_by_subject": avg_by_subject if avg_by_subject else None,
            })

    # ── Fairness metrics (all computed in Python) ────────────────────────────
    rates = [g["pass_rate"] for g in group_stats if g["pass_rate"] is not None]
    dpd    = round(max(rates) - min(rates), 4) if len(rates) >= 2 else 0.0
    dir_   = round(min(rates) / max(rates), 4) if len(rates) >= 2 and max(rates) > 0 else 1.0
    pass_rate_gap = dpd
    avg_marks_list = [g["avg_marks"] for g in group_stats if g["avg_marks"] is not None]
    avg_marks_gap  = round(max(avg_marks_list) - min(avg_marks_list), 2) if len(avg_marks_list) >= 2 else 0.0

    # Subject fairness: stddev of per-subject pass rates across groups
    subj_fairness = 1.0
    if sub_col and len(group_stats) >= 2:
        variances = []
        for s in df[sub_col].dropna().unique():
            srates = []
            for g_stat in group_stats:
                g = g_stat["group"]
                sdf = df[(df[sensitive_col] == g) & (df[sub_col] == s)]
                if target_col and len(sdf) > 0 and positive_class is not None:
                    sr = float((sdf[target_col] == positive_class).mean())
                    srates.append(sr)
            if len(srates) >= 2:
                variances.append(float(np.std(srates)))
        if variances:
            subj_fairness = round(max(0.0, 1.0 - float(np.mean(variances))), 4)

    metrics = [
        {
            "name": "Demographic Parity Difference",
            "key": "demographic_parity_difference",
            "value": dpd,
            "threshold": 0.10,
            "threshold_direction": "below",
            "flagged": dpd > 0.10,
        },
        {
            "name": "Disparate Impact Ratio",
            "key": "disparate_impact_ratio",
            "value": dir_,
            "threshold": 0.80,
            "threshold_direction": "above",
            "flagged": dir_ < 0.80,
        },
        {
            "name": "Pass Rate Gap",
            "key": "pass_rate_gap",
            "value": pass_rate_gap,
            "threshold": 0.10,
            "threshold_direction": "below",
            "flagged": pass_rate_gap > 0.10,
        },
        {
            "name": "Average Marks Gap",
            "key": "avg_marks_gap",
            "value": avg_marks_gap,
            "threshold": 5.0,
            "threshold_direction": "below",
            "flagged": avg_marks_gap > 5.0,
        },
        {
            "name": "Subject Fairness Score",
            "key": "subject_fairness_score",
            "value": subj_fairness,
            "threshold": 0.80,
            "threshold_direction": "above",
            "flagged": subj_fairness < 0.80,
        },
    ]

    # ── Bias score (computed in Python) ─────────────────────────────────────
    flag_count = sum(1 for m in metrics if m["flagged"])
    dpd_component = min(dpd / 0.30, 1.0) * 40          # 0-40 pts
    dir_component = max(0.0, (0.80 - dir_) / 0.80) * 25  # 0-25 pts
    gap_component = min(avg_marks_gap / 20.0, 1.0) * 20  # 0-20 pts
    flag_component = (flag_count / len(metrics)) * 15     # 0-15 pts
    bias_score = round(dpd_component + dir_component + gap_component + flag_component, 1)
    bias_score = max(0.0, min(100.0, bias_score))

    if bias_score < 20:
        bias_level, risk_label = "Low", "Low Risk"
    elif bias_score < 45:
        bias_level, risk_label = "Moderate", "Moderate Risk"
    elif bias_score < 70:
        bias_level, risk_label = "High", "High Risk"
    else:
        bias_level, risk_label = "Critical", "Critical Risk"

    # ── Subject analysis ─────────────────────────────────────────────────────
    subject_analysis: list[dict] = []
    if sub_col:
        for s in sorted(df[sub_col].dropna().unique(), key=str):
            sdf = df[df[sub_col] == s]
            s_avg = round(float(sdf[marks_col].mean()), 2) if marks_col else 0.0
            s_pass = 0.0
            if target_col and positive_class is not None and len(sdf) > 0:
                s_pass = round(float((sdf[target_col] == positive_class).mean()), 4)
            # Flag if group gap within subject > 0.15
            group_rates_in_sub = []
            if sensitive_col and sensitive_col in df.columns:
                for g_stat in group_stats:
                    g = g_stat["group"]
                    sgdf = sdf[sdf[sensitive_col] == g]
                    if target_col and len(sgdf) > 0 and positive_class is not None:
                        group_rates_in_sub.append(float((sgdf[target_col] == positive_class).mean()))
            s_flagged = (max(group_rates_in_sub) - min(group_rates_in_sub)) > 0.15 if len(group_rates_in_sub) >= 2 else False
            subject_analysis.append({
                "subject": str(s),
                "teacher": None,   # AI will fill this from description
                "avg_marks": s_avg,
                "pass_rate": s_pass,
                "flagged": s_flagged,
                "bias_note": None, # AI will fill this
            })

    # ── Grade summary (for context) ──────────────────────────────────────────
    grade_lines = []
    if grade_col:
        for gr in sorted(df[grade_col].dropna().unique()):
            gdf = df[df[grade_col] == gr]
            if target_col and positive_class is not None:
                pr = float((gdf[target_col] == positive_class).mean())
                grade_lines.append(f"  Grade {gr}: {len(gdf)} rows, pass_rate={pr:.2%}")

    # ── Compact text summary for AI ──────────────────────────────────────────
    group_lines = []
    for gs in group_stats:
        subj_detail = ""
        if gs["avg_by_subject"]:
            parts = [f"{k}={v:.1f}" for k, v in gs["avg_by_subject"].items()]
            subj_detail = " | by subject: " + ", ".join(parts)
        group_lines.append(
            f"  {gs['group']}: n={gs['count']}, avg_marks={gs['avg_marks']}, "
            f"pass={gs['pass_count']}, fail={gs['fail_count']}, pass_rate={gs['pass_rate']:.2%}{subj_detail}"
        )

    subj_lines = []
    for sa in subject_analysis:
        subj_lines.append(
            f"  {sa['subject']}: avg={sa['avg_marks']:.1f}, pass_rate={sa['pass_rate']:.2%}, "
            f"flagged={sa['flagged']}"
        )

    metric_lines = [
        f"  DPD={dpd:.4f} (threshold <0.10, flagged={dpd > 0.10})",
        f"  DIR={dir_:.4f} (threshold >=0.80, flagged={dir_ < 0.80})",
        f"  Pass Rate Gap={pass_rate_gap:.4f}",
        f"  Avg Marks Gap={avg_marks_gap:.2f}",
        f"  Subject Fairness Score={subj_fairness:.4f}",
    ]

    compact_summary = f"""Dataset: {int(len(df))} rows, columns: {list(df.columns)}
Target column: {target_col} | Positive class: {positive_class}
Sensitive column: {sensitive_col}
Subject column: {sub_col}
Grade column: {grade_col}

Groups:
{chr(10).join(group_lines) if group_lines else '  (no group data)'}

Subjects:
{chr(10).join(subj_lines) if subj_lines else '  (no subject data)'}

Fairness metrics (all computed):
{chr(10).join(metric_lines)}

Computed bias_score: {bias_score} ({bias_level})

Grade trends:
{chr(10).join(grade_lines) if grade_lines else '  (no grade data)'}"""

    return {
        "compact_summary": compact_summary,
        "description": description,
        # Numbers already computed — returned directly to avoid re-computation
        "computed": {
            "bias_score": bias_score,
            "bias_level": bias_level,
            "risk_label": risk_label,
            "bias_detected": bias_score >= 20,
            "total_rows": int(len(df)),
            "columns": list(df.columns),
            "metrics": metrics,
            "group_stats": group_stats,
            "subject_analysis": subject_analysis,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3.  BUILD PROMPT  — compact, text only, no JSON dump
# ─────────────────────────────────────────────────────────────────────────────

def build_prompt(stats: dict) -> str:
    desc = stats["description"]
    summary = stats["compact_summary"]
    subjects = [sa["subject"] for sa in stats["computed"]["subject_analysis"]]
    subj_list = ", ".join(f'"{s}"' for s in subjects)

    # Build subject_details template entries
    subj_entries = ",\n    ".join(
        f'{{"subject": "{s}", "teacher": null, "bias_note": null}}'
        for s in subjects
    )

    schema = (
        '{"metric_interpretations":{' +
        '"demographic_parity_difference":"sentence",' +
        '"disparate_impact_ratio":"sentence",' +
        '"pass_rate_gap":"sentence",' +
        '"avg_marks_gap":"sentence",' +
        '"subject_fairness_score":"sentence"' +
        '},' +
        f'"subject_details":[{subj_entries}],' +
        '"summary":"para1\\n\\npara2\\n\\npara3",' +
        '"key_findings":["f1","f2","f3","f4","f5"],' +
        '"recommendations":["r1","r2","r3","r4"]}' 
    )

    return (
        "You are FairLens, an AI fairness auditor. "
        "All numbers are pre-computed. Your ONLY job is to fill in the text fields below.\n\n"
        f"DATASET DESCRIPTION: {desc}\n\n"
        f"KEY STATISTICS:\n{summary}\n\n"
        "OUTPUT RULES (strictly follow every rule):\n"
        "1. Output ONLY the JSON object. No markdown, no ```json fences, no text before or after.\n"
        "2. Double quotes for all strings. Use null (not None), true/false (not True/False).\n"
        "3. No trailing commas anywhere.\n"
        "4. metric_interpretations: 1 plain-English sentence, max 20 words each.\n"
        "5. summary: exactly 3 short paragraphs, separated by \\n\\n, total max 80 words.\n"
        "6. key_findings: exactly 5 strings, max 25 words each.\n"
        "7. recommendations: exactly 4 strings, max 20 words each.\n"
        f"8. subject_details: exactly these subjects: {subj_list}\n\n"
        "Fill in ALL the quoted placeholder values in this JSON structure:\n"
        + schema
    )



# ─────────────────────────────────────────────────────────────────────────────
# 4.  ROBUST JSON EXTRACTION
# ─────────────────────────────────────────────────────────────────────────────

def extract_json(text: str) -> dict:
    """
    Robustly extract valid JSON from Gemini output.
    Tries strategies in order until one works.
    """
    def _try_parse(s: str):
        try:
            return json.loads(s)
        except Exception:
            return None

    # 1. Direct parse
    result = _try_parse(text)
    if result is not None:
        return result

    # 2. Strip markdown fences
    cleaned = re.sub(r"```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    result = _try_parse(cleaned)
    if result is not None:
        return result

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
                    candidate = text[start: i + 1]
                    result = _try_parse(candidate)
                    if result is not None:
                        return result
                    # Try fixing common issues
                    fixed = _fix_json(candidate)
                    result = _try_parse(fixed)
                    if result is not None:
                        return result
                    break

    # 4. Fix on the cleaned version too
    fixed = _fix_json(cleaned)
    result = _try_parse(fixed)
    if result is not None:
        return result

    # 5. Truncation repair — JSON cut off before closing braces/brackets
    for source in (text, cleaned):
        repaired = _repair_truncated_json(source)
        if repaired:
            result = _try_parse(repaired) or _try_parse(_fix_json(repaired))
            if result is not None:
                return result

    raise ValueError(
        f"Could not parse Gemini response as JSON. "
        f"First 400 chars of response: {text[:400]!r}"
    )


def _fix_json(s: str) -> str:
    """Fix the most common JSON issues Gemini produces."""
    # Strip comments
    s = re.sub(r'(?<!https:)(?<!http:)//[^\n"]*', '', s)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
    # Trailing commas
    s = re.sub(r",\s*([}\]])", r"\1", s)
    # Python literals
    s = re.sub(r"\bNone\b", "null", s)
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    # Control chars
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return s

def _repair_truncated_json(s: str) -> str:
    """
    Recover partial JSON by scanning backwards from the truncation point
    to find the last position where the JSON was structurally complete,
    then close all open containers.

    Handles:
      - Truncated mid-string value (most common Gemini failure)
      - Truncated inside a nested object/array
      - Truncated after a comma (incomplete next item)
    """
    start = s.find("{")
    if start == -1:
        return ""
    s = s[start:]
    if not s.strip():
        return ""

    # We try progressively shorter cuts of the string, walking backwards
    # character by character from the end, until we find a suffix removal
    # that produces balanced-enough JSON to close.
    # This is O(n) in practice because we only look for a few boundary chars.

    # First: identify all positions that are "safe endings" — positions just
    # after a closing " } ] where depth > 0.
    safe_positions = []
    in_string = False
    escape_next = False
    stack = []

    for i, ch in enumerate(s):
        if escape_next:
            escape_next = False
            continue
        if in_string:
            if ch == '\\':
                escape_next = True
            elif ch == '"':
                in_string = False
                # Only a safe position if the preceding non-ws context isn't a key
                # We approximate: mark it, then filter below
                safe_positions.append(('str_close', i + 1, list(stack)))
            continue
        if ch == '"':
            in_string = True
            continue
        if ch in ('{', '['):
            stack.append(ch)
        elif ch == '}':
            if stack and stack[-1] == '{':
                stack.pop()
            safe_positions.append(('obj_close', i + 1, list(stack)))
        elif ch == ']':
            if stack and stack[-1] == '[':
                stack.pop()
            safe_positions.append(('arr_close', i + 1, list(stack)))

    if not stack:
        return s  # already balanced

    # Walk safe_positions backwards — find the last one where:
    # 1. It's a } or ] close (definitely a value end), OR
    # 2. It's a string close AND it's followed only by whitespace/comma/} not by ":"
    closers = {"[": "]", "{": "}"}

    for kind, pos, stk_at_pos in reversed(safe_positions):
        # After this position, what follows?
        after = s[pos:].lstrip()
        if kind in ('obj_close', 'arr_close'):
            # Definitely safe — close remaining open containers
            tail = s[:pos].rstrip().rstrip(',')
            for opener in reversed(stk_at_pos):
                tail += closers.get(opener, "}")
            return tail
        elif kind == 'str_close':
            # Safe only if next meaningful char is , } ] (not :)
            if not after or after[0] in (',', '}', ']', '\n', '\r', ' '):
                tail = s[:pos].rstrip().rstrip(',')
                for opener in reversed(stk_at_pos):
                    tail += closers.get(opener, "}")
                return tail
            # If followed by : it's a key-close — not a safe value end, skip

    return ""


# ─────────────────────────────────────────────────────────────────────────────
# 5.  MERGE — Python numbers + AI text → AuditResponse
# ─────────────────────────────────────────────────────────────────────────────

def merge_into_response(stats: dict, ai: dict) -> AuditResponse:
    computed = stats["computed"]
    interps  = ai.get("metric_interpretations", {})
    subj_det = {d["subject"]: d for d in ai.get("subject_details", []) if "subject" in d}

    # Metrics: use Python values, AI interpretations
    metrics = []
    for m in computed["metrics"]:
        metrics.append(MetricResult(
            name=m["name"],
            key=m["key"],
            value=m["value"],
            threshold=m.get("threshold"),
            threshold_direction=m.get("threshold_direction", "below"),
            flagged=m["flagged"],
            interpretation=interps.get(m["key"], ""),
        ))

    # Group stats
    group_stats = [GroupStats(**g) for g in computed["group_stats"]]

    # Subject analysis: Python numbers, AI teacher + bias_note
    subject_analysis = []
    for sa in computed["subject_analysis"]:
        det = subj_det.get(sa["subject"], {})
        subject_analysis.append(SubjectAnalysis(
            subject=sa["subject"],
            teacher=det.get("teacher"),
            avg_marks=sa["avg_marks"],
            pass_rate=sa["pass_rate"],
            flagged=sa["flagged"],
            bias_note=det.get("bias_note"),
        ))

    # Compact summary for chat
    audit_summary = json.dumps({
        "bias_score": computed["bias_score"],
        "bias_level": computed["bias_level"],
        "metrics": [{m.key: round(m.value, 4)} for m in metrics],
        "group_stats": [{"group": g.group, "pass_rate": g.pass_rate, "avg_marks": g.avg_marks}
                        for g in group_stats],
        "key_findings": ai.get("key_findings", []),
    })

    return AuditResponse(
        bias_score=computed["bias_score"],
        bias_level=computed["bias_level"],
        risk_label=computed["risk_label"],
        bias_detected=computed["bias_detected"],
        total_rows=computed["total_rows"],
        total_students=None,
        columns=computed["columns"],
        sensitive_column=None,
        target_column=None,
        metrics=metrics,
        group_stats=group_stats,
        subject_analysis=subject_analysis if subject_analysis else None,
        summary=ai.get("summary", ""),
        key_findings=ai.get("key_findings", []),
        recommendations=ai.get("recommendations", []),
        audit_summary_json=audit_summary,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 6.  GEMINI CALL
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
                    # Do NOT use responseMimeType:application/json —
                    # Gemini truncates JSON mode output without closing braces.
                    # Plain text + our extractor is more reliable.
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
# 7.  CHAT
# ─────────────────────────────────────────────────────────────────────────────

async def run_chat(request: ChatRequest) -> ChatResponse:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")

    system_context = (
        f"You are FairLens, an AI fairness auditor assistant.\n"
        f"Dataset description: {request.dataset_description}\n"
        f"Audit findings: {request.audit_summary}\n\n"
        f"Answer the user's questions about the audit. Be concise (2-3 paragraphs max), "
        f"reference actual numbers from the findings, and give practical recommendations."
    )

    history_text = ""
    for m in request.conversation:
        role = "User" if m["role"] == "user" else "Assistant"
        history_text += f"{role}: {m['content']}\n\n"

    full_prompt = f"{system_context}\n\n{history_text}User: {request.message}\n\nAssistant:"

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": full_prompt}]}],
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 800},
            },
        )

    resp.raise_for_status()
    reply = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    return ChatResponse(reply=reply)


# ─────────────────────────────────────────────────────────────────────────────
# 8.  MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

async def run_audit(request: AuditRequest) -> AuditResponse:
    df = decode_csv(request.dataset)

    stats = compute_raw_stats(
        df,
        description=request.description,
        target_col=request.target_column,
        sensitive_col=request.sensitive_column,
        sensitive_col_2=request.sensitive_column_2,
    )

    prompt = build_prompt(stats)
    ai = await call_gemini(prompt)

    response = merge_into_response(stats, ai)

    # Patch in the columns that came from the request
    response.sensitive_column = request.sensitive_column
    response.target_column = request.target_column

    return response