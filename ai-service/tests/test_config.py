"""Startup configuration: unsafe settings must stop the service instead of running quietly."""

import pytest

from app.config import ConfigurationError, Settings


@pytest.fixture
def environment(monkeypatch):
    """Applies variables for one test; monkeypatch restores the shared test environment afterwards."""

    def apply(**variables):
        for variable_name, value in variables.items():
            monkeypatch.setenv(variable_name, value)

    return apply


def test_the_test_environment_is_valid():
    settings = Settings.from_environment()
    assert settings.groq_api_key is None
    assert settings.simulated_tools_enabled is True


def test_a_short_internal_api_key_is_refused(environment):
    environment(AI_SERVICE_API_KEY="short")
    with pytest.raises(ConfigurationError, match="AI_SERVICE_API_KEY"):
        Settings.from_environment()


def test_simulated_tools_are_forbidden_in_production(environment):
    environment(APP_ENV="production", SIMULATED_TOOLS_ENABLED="true")
    with pytest.raises(ConfigurationError, match="SIMULATED_TOOLS_ENABLED"):
        Settings.from_environment()


def test_simulated_tools_default_off_in_production(environment):
    environment(APP_ENV="production", SIMULATED_TOOLS_ENABLED="")
    assert Settings.from_environment().simulated_tools_enabled is False


def test_the_backend_url_must_be_https_in_production(environment):
    environment(APP_ENV="production", SIMULATED_TOOLS_ENABLED="false", BACKEND_INTERNAL_URL="http://backend:5000")
    with pytest.raises(ConfigurationError, match="https"):
        Settings.from_environment()


def test_the_turn_deadline_must_exceed_the_model_timeout(environment):
    environment(LLM_REQUEST_TIMEOUT_SECONDS="20", AI_PROCESS_TIMEOUT_SECONDS="10")
    with pytest.raises(ConfigurationError, match="AI_PROCESS_TIMEOUT_SECONDS"):
        Settings.from_environment()


def test_telemetry_needs_a_backend_url(environment):
    environment(AGENT_TELEMETRY_ENABLED="true", BACKEND_INTERNAL_URL="")
    with pytest.raises(ConfigurationError, match="AGENT_TELEMETRY_ENABLED"):
        Settings.from_environment()


def test_knowledge_answer_settings_have_measured_defaults(environment):
    settings = Settings.from_environment()
    assert settings.knowledge_answer_top_k == 6
    assert settings.knowledge_min_relevance == 0.6
    assert settings.knowledge_answer_history_messages == 6
    assert settings.knowledge_excerpt_chars == 1200
    assert settings.knowledge_answer_temperature == 0.1


@pytest.mark.parametrize(
    ("variable_name", "value"),
    [
        ("KNOWLEDGE_MIN_RELEVANCE", "1.5"),
        ("KNOWLEDGE_ANSWER_TOP_K", "0"),
        ("KNOWLEDGE_ANSWER_HISTORY_MESSAGES", "50"),
        ("KNOWLEDGE_EXCERPT_CHARS", "many"),
        ("KNOWLEDGE_ANSWER_TEMPERATURE", "2"),
    ],
)
def test_knowledge_answer_settings_out_of_range_are_refused(environment, variable_name, value):
    environment(**{variable_name: value})
    with pytest.raises(ConfigurationError, match=variable_name):
        Settings.from_environment()
