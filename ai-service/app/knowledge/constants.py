"""
Fixed facts of the department knowledge index. The limits mirror the backend's
KNOWLEDGE_BASE_SETTINGS (backend/constants/validation.js) with a little headroom, so a valid batch
from the backend is never refused while anything larger is.
"""

from __future__ import annotations

import uuid

# One Qdrant collection holds every department's chunks; each chunk's payload names its company,
# department, agent and document, and every search filters on the department.
COLLECTION_NAME = "department_knowledge"

# BAAI/bge-small-en-v1.5 (MIT), in the quantised ONNX build fastembed uses
# (Hugging Face: Qdrant/bge-small-en-v1.5-onnx-Q). Its vectors have 384 dimensions and are
# normalised, so cosine distance is the right measure.
EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMENSIONS = 384

# Point ids are UUIDv5 of "<document id>:<chunk number>" in this namespace, so indexing a document
# again overwrites its chunks instead of adding new ones. Never change it: existing points would no
# longer be overwritten.
POINT_ID_NAMESPACE = uuid.UUID("6f3b4a2e-9d1c-5e8a-b7f0-2c4d6e8a0b1c")

ACCESS_LEVEL_DEPARTMENT = "DEPARTMENT"

# Payload fields that searches and deletes filter on; each has a keyword index.
FILTERED_PAYLOAD_FIELDS = ("company_id", "department_id", "agent_id", "document_id", "access_level")

# Request limits (the backend sends 16 chunks of at most 1,800 characters, with up to 6 headings).
MAX_CHUNKS_PER_REQUEST = 64
MAX_CHUNK_TEXT_CHARS = 2_000
MAX_CHUNK_INDEX = 10_000
MAX_HEADING_LEVELS = 6
MAX_HEADING_CHARS = 500
MAX_PAGE_NUMBER = 10_000

# Ids from the backend are MongoDB ObjectIds: 24 lowercase hexadecimal characters.
OBJECT_ID_PATTERN = r"^[0-9a-f]{24}$"

# Chunks embedded per model call inside one request.
EMBEDDING_BATCH_SIZE = 16

# A collection another instance has just created can briefly answer reads with an error while its
# shards start; ensure_collection waits for it this many times, this long apart.
COLLECTION_READY_ATTEMPTS = 20
COLLECTION_READY_DELAY_SECONDS = 0.25

# External knowledge: web pages NSK read (backend services/webResearch/), one collection beside the
# department knowledge, sharing its embedding model. Each chunk names its source (the backend's
# ExternalSource id), URL, domain, title, when it was fetched and when it expires (seconds since the
# epoch, for range filters), and whether it is approved for everyone.
EXTERNAL_COLLECTION_NAME = "external_knowledge"
EXTERNAL_POINT_ID_NAMESPACE = uuid.UUID("3c9e1f4a-7b2d-5c6e-8f0a-1d2b3c4e5f60")
EXTERNAL_KEYWORD_FIELDS = ("source_id", "domain")
EXTERNAL_BOOL_FIELDS = ("approved",)
EXTERNAL_FLOAT_FIELDS = ("expires_at_ts",)
MAX_SOURCES_PER_REQUEST = 100
MAX_URL_CHARS = 2048
MAX_TITLE_CHARS = 300
MAX_DOMAIN_CHARS = 253
