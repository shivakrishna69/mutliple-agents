"""
Downloads the knowledge embedding model into a folder and checks every file against
app/knowledge/embedding_model.sha256, failing when anything differs. The production image runs it
while it is built (Dockerfile), so the running service never downloads anything:

    python -m app.knowledge.download_model /opt/models

It also loads the model offline from that folder once, the way the service will, so a model the
service could not load fails the build instead.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from app.knowledge.constants import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_NAME

CHECKSUM_FILE = Path(__file__).with_name("embedding_model.sha256")
READ_CHUNK_BYTES = 1024 * 1024


def expected_checksums() -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in CHECKSUM_FILE.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            digest, file_name = line.split()
            checksums[file_name] = digest
    return checksums


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        while block := model_file.read(READ_CHUNK_BYTES):
            digest.update(block)
    return digest.hexdigest()


def verify(model_root: Path) -> None:
    """Every expected file is present, under the model's snapshot folder, with its recorded digest."""
    found = {path.name: path for path in model_root.rglob("*") if path.is_file() and "snapshots" in path.parts}
    for file_name, digest in expected_checksums().items():
        if file_name not in found:
            raise SystemExit(f"model file missing: {file_name}")
        actual = sha256_of(found[file_name].resolve())
        if actual != digest:
            raise SystemExit(f"model file {file_name} has checksum {actual}, expected {digest}")


def main(target: str) -> None:
    from fastembed import TextEmbedding

    model_root = Path(target)
    TextEmbedding(EMBEDDING_MODEL_NAME, cache_dir=str(model_root))
    verify(model_root)
    offline_model = TextEmbedding(EMBEDDING_MODEL_NAME, cache_dir=str(model_root), local_files_only=True)
    vector = next(iter(offline_model.embed(["model check"])))
    if len(vector) != EMBEDDING_DIMENSIONS:
        raise SystemExit(f"model returned {len(vector)} dimensions, expected {EMBEDDING_DIMENSIONS}")
    print(f"{EMBEDDING_MODEL_NAME}: files verified, loads offline, {EMBEDDING_DIMENSIONS} dimensions")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m app.knowledge.download_model <folder>")
    main(sys.argv[1])
