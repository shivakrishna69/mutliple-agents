"""
Test configuration shared by every test module.

app.config reads the environment (and ai-service/.env) when app.main is first imported, so the
values below are set before any app module is imported. They are assigned unconditionally: a
developer's .env never fills them in (load_dotenv does not override variables that already exist),
so tests never use a real Groq key, never call the backend, and behave the same on every machine.
"""

import os

TEST_INTERNAL_API_KEY = "test-internal-api-key-0123456789abcdef"

os.environ.update(
    {
        "APP_ENV": "development",
        "LOG_LEVEL": "WARNING",
        "AI_SERVICE_API_KEY": TEST_INTERNAL_API_KEY,
        "GROQ_API_KEY": "",
        "GROQ_BASE_URL": "",
        "BACKEND_INTERNAL_URL": "",
        "AGENT_TELEMETRY_ENABLED": "false",
        "SIMULATED_TOOLS_ENABLED": "true",
        "LLM_REASONING_EFFORT": "low",
        "LLM_REQUEST_TIMEOUT_SECONDS": "8",
        "AI_PROCESS_TIMEOUT_SECONDS": "18",
    }
)
