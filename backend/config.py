import os
from dotenv import load_dotenv

load_dotenv()

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
# Optional OpenAI-compatible API root (e.g. https://api.openai.com/v1 or a proxy). Empty = SDK default.
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "").strip()

# Optional cost estimation (USD per 1K tokens). If unset, cost stays null.
OPENAI_USD_PER_1K_INPUT_TOKENS = float(os.getenv("OPENAI_USD_PER_1K_INPUT_TOKENS", "0") or "0")
OPENAI_USD_PER_1K_OUTPUT_TOKENS = float(os.getenv("OPENAI_USD_PER_1K_OUTPUT_TOKENS", "0") or "0")

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# When true, logs every judge LLM call with prompts/responses (truncated) to lens-ragas-web.llm at INFO.
LLM_DETAIL_LOG = os.getenv("LLM_DETAIL_LOG", "").strip().lower() in ("1", "true", "yes", "on")
LLM_LOG_MAX_CHARS = max(500, int(os.getenv("LLM_LOG_MAX_CHARS", "12000")))

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "data", "runs.sqlite"))
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
