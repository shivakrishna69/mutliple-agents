"""
The leave assistant (POST /ai/leave/assistant): answers an employee's questions about their own
leave and prepares drafts they review and send themselves. It reads through the backend's internal
leave API and never writes. See assistant.py for a turn, tools.py for the tools, systems.py for the
backend access, and schemas.py for the contract with the backend.
"""

from app.nodes.leave_assistant.assistant import LeaveAssistant, LeaveAssistantResult
from app.nodes.leave_assistant.schemas import LeaveAssistantInput, LeaveAssistantResponse, LeaveDraft
from app.nodes.leave_assistant.systems import (
    BackendLeaveSystems,
    LeaveDataUnavailableError,
    LeaveRequestRefusedError,
    LeaveSystems,
)

__all__ = [
    "BackendLeaveSystems",
    "LeaveAssistant",
    "LeaveAssistantInput",
    "LeaveAssistantResponse",
    "LeaveAssistantResult",
    "LeaveDataUnavailableError",
    "LeaveDraft",
    "LeaveRequestRefusedError",
    "LeaveSystems",
]
