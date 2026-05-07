from pydantic import BaseModel
from typing import Optional, Any


class EvalRequest(BaseModel):
    file_id: str
    metrics: list[str]
    llm_provider: str
    project: Optional[str] = None
    # Optional: allows tabular files (.csv/.xlsx) with non-canonical headers.
    # Shape: canonical_key -> source_column_name
    # Example: {"question": "Query", "contexts": "Retrieved", "ground_truth": "GT", "answer": "Answer"}
    column_map: Optional[dict[str, str]] = None
    input_filename: Optional[str] = None
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None


class ParsedFile(BaseModel):
    file_id: str
    row_count: int
    columns: list[str]
    available_metrics: list[str]
    format: str  # "lens" | "generic"
    lens_metadata: Optional[Any] = None
    needs_column_mapping: bool = False
    column_map: Optional[dict[str, str]] = None


class ParseMapRequest(BaseModel):
    file_id: str
    column_map: dict[str, str]
