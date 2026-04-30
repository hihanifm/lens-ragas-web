import json
import pandas as pd
from typing import AsyncGenerator, Awaitable, Callable, Optional
from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.metrics import Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper

def _new_metric(name: str):
    if name == "faithfulness":
        return Faithfulness()
    if name == "answer_relevancy":
        return AnswerRelevancy()
    if name == "context_precision":
        return ContextPrecision()
    if name == "context_recall":
        return ContextRecall()
    raise KeyError(name)

# Metrics that require an `answer` field
ANSWER_REQUIRED = {"faithfulness", "answer_relevancy"}
# Metrics that require a `ground_truth` field
GROUND_TRUTH_REQUIRED = {"context_precision", "context_recall"}


def detect_format(columns: list[str]) -> tuple[str, list[str]]:
    cols = set(c.lower() for c in columns)
    available = []

    has_question = "question" in cols
    has_contexts = "contexts" in cols
    has_answer = "answer" in cols
    has_ground_truth = "ground_truth" in cols

    if not has_question or not has_contexts:
        raise ValueError("File must have at least 'question' and 'contexts' columns.")

    if has_answer:
        available += ["faithfulness", "answer_relevancy"]
    if has_ground_truth:
        available += ["context_precision", "context_recall"]

    fmt = "lens" if not has_answer else "generic"
    return fmt, available


def load_rows(filepath: str) -> list[dict]:
    if filepath.endswith(".json"):
        with open(filepath) as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("results", [])

    df = pd.read_csv(filepath, dtype=str)
    rows = []
    for _, row in df.iterrows():
        r = row.to_dict()
        # contexts column may be a JSON string like '["ctx1","ctx2"]'
        if "contexts" in r and isinstance(r["contexts"], str):
            try:
                r["contexts"] = json.loads(r["contexts"])
            except Exception:
                r["contexts"] = [r["contexts"]]
        rows.append(r)
    return rows


def build_llm(req):
    if req.llm_provider == "openai":
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings
        lc_llm = ChatOpenAI(
            model=req.openai_model or "gpt-4o-mini",
            api_key=req.openai_api_key,
        )
        lc_emb = OpenAIEmbeddings(
            model="text-embedding-3-small",
            api_key=req.openai_api_key,
        )
        return LangchainLLMWrapper(lc_llm), LangchainEmbeddingsWrapper(lc_emb)
    else:
        from langchain_ollama import ChatOllama, OllamaEmbeddings
        base_url = req.ollama_base_url or "http://localhost:11434"
        model = req.ollama_model or "llama3.2"
        lc_llm = ChatOllama(model=model, base_url=base_url)
        lc_emb = OllamaEmbeddings(model=model, base_url=base_url)
        return LangchainLLMWrapper(lc_llm), LangchainEmbeddingsWrapper(lc_emb)


async def run_evaluation(
    filepath: str,
    req,
    *,
    is_disconnected: Optional[Callable[[], Awaitable[bool]]] = None,
    batch_size: int = 1,
) -> AsyncGenerator[str, None]:
    rows = load_rows(filepath)
    if not rows:
        raise ValueError("No rows found in file.")

    cols = list(rows[0].keys())
    _, available = detect_format(cols)

    selected = [m for m in req.metrics if m in available]
    if not selected:
        raise ValueError("No applicable metrics for this file and selection.")

    llm_wrapper, emb_wrapper = build_llm(req)

    samples = []
    for row in rows:
        contexts = row.get("contexts", [])
        if isinstance(contexts, str):
            try:
                contexts = json.loads(contexts)
            except Exception:
                contexts = [contexts]

        sample = SingleTurnSample(
            user_input=row.get("question", ""),
            retrieved_contexts=contexts,
            response=row.get("answer") if "answer" in row else None,
            reference=row.get("ground_truth") if "ground_truth" in row else None,
        )
        samples.append(sample)

    dataset = EvaluationDataset(samples=samples)
    total = len(samples)
    yield _sse("start", {"total": total, "metrics": selected})

    if batch_size < 1:
        batch_size = 1

    sums: dict[str, float] = {m: 0.0 for m in selected}
    counts: dict[str, int] = {m: 0 for m in selected}

    for batch_start in range(0, total, batch_size):
        if is_disconnected is not None and await is_disconnected():
            return

        batch_end = min(total, batch_start + batch_size)
        batch_samples = samples[batch_start:batch_end]

        metrics = [_new_metric(m) for m in selected]
        for m in metrics:
            m.llm = llm_wrapper
            if hasattr(m, "embeddings"):
                m.embeddings = emb_wrapper

        batch_dataset = EvaluationDataset(samples=batch_samples)
        result = evaluate(batch_dataset, metrics=metrics)
        df = result.to_pandas()

        for local_i, row_scores in enumerate(df.to_dict(orient="records")):
            i = batch_start + local_i
            scores: dict[str, float | None] = {}
            for k in selected:
                v = row_scores.get(k)
                if v is None or pd.isna(v):
                    scores[k] = None
                    continue
                fv = float(v)
                sums[k] += fv
                counts[k] += 1
                scores[k] = round(fv, 4)

            yield _sse(
                "row",
                {
                    "index": i,
                    "question": rows[i].get("question", ""),
                    "scores": scores,
                },
            )

    agg = {
        m: (round(sums[m] / counts[m], 4) if counts[m] else None)
        for m in selected
    }
    yield _sse("complete", {"aggregate": agg, "total": total})


def _sse(event: str, data: dict) -> str:
    import json as _json
    return f"event: {event}\ndata: {_json.dumps(data)}\n\n"
