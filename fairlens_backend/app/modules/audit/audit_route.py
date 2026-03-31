"""
audit_route.py — /audit-dataset and /audit-chat endpoints
"""

from fastapi import APIRouter, HTTPException
from app.schemas.audit_schema import AuditRequest, AuditResponse, ChatRequest, ChatResponse
from app.modules.audit.audit_service import run_audit, run_chat

router = APIRouter(tags=["Audit"])


@router.post("/audit-dataset", response_model=AuditResponse)
async def audit_dataset(request: AuditRequest):
    """
    POST /audit-dataset
    Body: { dataset, description, target_column?, sensitive_column? }
    Returns structured AI fairness audit report.
    """
    try:
        return await run_audit(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Audit failed: {str(e)}")


@router.post("/audit-chat", response_model=ChatResponse)
async def audit_chat(request: ChatRequest):
    """
    POST /audit-chat
    Body: { dataset_description, audit_summary, conversation, message }
    Returns AI reply for follow-up questions about the audit.
    """
    try:
        return await run_chat(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")
