"""
The NSK assistant (POST /ai/nsk/turn): the HR portal's assistant. Each turn classifies the message
(classifier.py), answers with the person's own tools and documents (tools.py, systems.py), checks
that every fact is traced to a source (grounding.py), and predicts the next questions
(suggestions.py). See assistant.py for a turn and schemas.py for the contract with the backend.
"""

from app.nodes.nsk_assistant.assistant import NskAssistant, NskTurnResult
from app.nodes.nsk_assistant.schemas import NskTurnInput, NskTurnResponse
from app.nodes.nsk_assistant.systems import (
    BackendNskSystems,
    DocumentSearch,
    NskDataUnavailableError,
    NskSystems,
    NskToolRefusedError,
)
from app.nodes.nsk_assistant.tools import SearchSettings

__all__ = [
    "BackendNskSystems",
    "DocumentSearch",
    "NskAssistant",
    "NskDataUnavailableError",
    "NskSystems",
    "NskToolRefusedError",
    "NskTurnInput",
    "NskTurnResponse",
    "NskTurnResult",
    "SearchSettings",
]
