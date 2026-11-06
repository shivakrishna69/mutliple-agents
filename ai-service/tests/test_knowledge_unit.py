"""Small rules of the knowledge index: point ids, what is embedded, and its configuration."""

import pytest

from app.config import ConfigurationError, Settings
from app.knowledge.embedder import passage_text
from app.knowledge.store import point_id

STRONG_KEY = "q" * 40


def test_point_ids_are_stable_per_document_and_chunk():
    assert point_id("65f1a2b3c4d5e6f708192a3b", 0) == point_id("65f1a2b3c4d5e6f708192a3b", 0)
    assert point_id("65f1a2b3c4d5e6f708192a3b", 0) != point_id("65f1a2b3c4d5e6f708192a3b", 1)
    assert point_id("65f1a2b3c4d5e6f708192a3b", 1) != point_id("65f1a2b3c4d5e6f708192a3c", 1)


def test_a_chunk_is_embedded_with_its_headings():
    assert passage_text("24 days a year.", ["Handbook", "Leave"]) == "Handbook > Leave\n\n24 days a year."
    assert passage_text("No headings here.", []) == "No headings here."


@pytest.fixture
def environment(monkeypatch):
    def apply(**variables):
        for name, value in variables.items():
            monkeypatch.setenv(name, value)
        return Settings.from_environment()

    return apply


def test_knowledge_is_off_without_qdrant(environment):
    settings = environment(QDRANT_URL="", QDRANT_API_KEY="")
    assert settings.qdrant_url is None


def test_qdrant_needs_a_strong_api_key(environment):
    with pytest.raises(ConfigurationError, match="QDRANT_API_KEY"):
        environment(QDRANT_URL="http://qdrant:6333", QDRANT_API_KEY="")
    with pytest.raises(ConfigurationError, match="QDRANT_API_KEY"):
        environment(QDRANT_URL="http://qdrant:6333", QDRANT_API_KEY="short")
    settings = environment(QDRANT_URL="http://qdrant:6333/", QDRANT_API_KEY=STRONG_KEY)
    assert settings.qdrant_url == "http://qdrant:6333"


def test_qdrant_url_must_be_http(environment):
    with pytest.raises(ConfigurationError, match="QDRANT_URL"):
        environment(QDRANT_URL="qdrant:6333", QDRANT_API_KEY=STRONG_KEY)


def test_production_never_downloads_the_model(environment):
    production = {"APP_ENV": "production", "SIMULATED_TOOLS_ENABLED": "false"}
    with pytest.raises(ConfigurationError, match="EMBEDDING_OFFLINE"):
        environment(**production, QDRANT_URL="http://qdrant:6333", QDRANT_API_KEY=STRONG_KEY, EMBEDDING_OFFLINE="")
    settings = environment(
        **production, QDRANT_URL="http://qdrant:6333", QDRANT_API_KEY=STRONG_KEY, EMBEDDING_OFFLINE="true"
    )
    assert settings.embedding_offline is True


def test_embedding_offline_takes_only_true_or_false(environment):
    with pytest.raises(ConfigurationError, match="EMBEDDING_OFFLINE"):
        environment(EMBEDDING_OFFLINE="yes")
