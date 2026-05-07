import json
import os
import pandas as pd
import time
import logging
from typing import AsyncGenerator, Awaitable, Callable, Optional
from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.metrics import Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ollama_utils import normalize_ollama_base_url
import config
import db


def _maybe_record_llm_usage(
    req,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    *,
    calls: int = 1,
) -> None:
    job_id = getattr(req, "job_id", None)
    if not job_id:
        return
    pt = int(prompt_tokens or 0)
    ct = int(completion_tokens or 0)

    cost_add = None
    if getattr(req, "llm_provider", None) == "openai":
        inp = float(getattr(config, "OPENAI_USD_PER_1K_INPUT_TOKENS", 0.0) or 0.0)
        out = float(getattr(config, "OPENAI_USD_PER_1K_OUTPUT_TOKENS", 0.0) or 0.0)
        if inp > 0 or out > 0:
            cost_add = (pt / 1000.0) * inp + (ct / 1000.0) * out

    # Some LangChain code paths batch multiple prompts into one `.generate()` call.
    # We track `llm_calls` per prompt best-effort, but only have token usage for the whole call.
    n = max(1, int(calls or 1))
    for i in range(n):
        db.incr_llm_usage(
            config.DB_PATH,
            job_id=job_id,
            prompt_tokens=(pt if i == 0 else 0),
            completion_tokens=(ct if i == 0 else 0),
            cost_usd_add=(cost_add if i == 0 else None),
        )


def _extract_usage_from_result(obj) -> tuple[int | None, int | None]:
    """
    Best-effort token extraction across LangChain return types.
    - `AIMessage`: `usage_metadata` or `response_metadata.token_usage`
    - `LLMResult`: `llm_output.token_usage`
    """
    if obj is None:
        return None, None

    usage = getattr(obj, "usage_metadata", None)
    if isinstance(usage, dict) and usage:
        pt = usage.get("input_tokens") or usage.get("prompt_tokens")
        ct = usage.get("output_tokens") or usage.get("completion_tokens")
        return (int(pt) if pt is not None else None, int(ct) if ct is not None else None)

    resp_meta = getattr(obj, "response_metadata", None)
    if isinstance(resp_meta, dict):
        token_usage = resp_meta.get("token_usage") or resp_meta.get("usage") or resp_meta.get("usage_metadata")
        if isinstance(token_usage, dict) and token_usage:
            pt = token_usage.get("prompt_tokens") or token_usage.get("input_tokens")
            ct = token_usage.get("completion_tokens") or token_usage.get("output_tokens")
            return (int(pt) if pt is not None else None, int(ct) if ct is not None else None)

    llm_output = getattr(obj, "llm_output", None)
    if isinstance(llm_output, dict):
        token_usage = llm_output.get("token_usage") or llm_output.get("usage")
        if isinstance(token_usage, dict) and token_usage:
            pt = token_usage.get("prompt_tokens") or token_usage.get("input_tokens")
            ct = token_usage.get("completion_tokens") or token_usage.get("output_tokens")
            return (int(pt) if pt is not None else None, int(ct) if ct is not None else None)

    return None, None

def _row_extra_fields(src: dict) -> dict:
    """Fields from the input row for display in the UI (not from ragas scores)."""
    ctx = src.get("contexts", [])
    if isinstance(ctx, str):
        try:
            ctx = json.loads(ctx)
        except Exception:
            ctx = [ctx]
    elif not isinstance(ctx, list):
        ctx = list(ctx) if ctx else []
    out: dict = {"contexts": ctx}
    if "ground_truth" in src:
        out["ground_truth"] = src.get("ground_truth")
    if "answer" in src:
        out["answer"] = src.get("answer")
    return out


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

logger = logging.getLogger("lens-ragas-web.evaluator")
llm_logger = logging.getLogger("lens-ragas-web.llm")


def _truncate_for_llm_log(text: str) -> str:
    n = int(getattr(config, "LLM_LOG_MAX_CHARS", 12000) or 12000)
    text = text or ""
    if len(text) <= n:
        return text
    return text[:n] + f"\n… [truncated, total_chars={len(text)}]"


def _message_content_piece(msg) -> str:
    c = getattr(msg, "content", msg)
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text") or "")
            elif isinstance(block, dict):
                parts.append(json.dumps(block, default=str)[:2000])
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(c)


def _format_invoke_args(args: tuple, kwargs: dict) -> str:
    max_c = getattr(config, "LLM_LOG_MAX_CHARS", 12000)
    # Drop heavy / noisy LangChain internals from kwargs copy.
    raw_kw = {k: v for k, v in kwargs.items() if k not in ("callbacks",)}
    preview = ""
    if args:
        a0 = args[0]
        if isinstance(a0, dict):
            if "messages" in a0 and isinstance(a0["messages"], list):
                bits = []
                for m in a0["messages"]:
                    role = type(m).__name__
                    bits.append(f"[{role}]\n{_message_content_piece(m)}")
                preview = "\n---\n".join(bits)
            else:
                try:
                    preview = json.dumps(a0, default=str)
                except TypeError:
                    preview = str(a0)
        elif isinstance(a0, list):
            bits = [f"[{type(m).__name__}]\n{_message_content_piece(m)}" for m in a0]
            preview = "\n---\n".join(bits)
        else:
            preview = str(a0)
        if len(args) > 1:
            preview += "\n...[extra_invoke_args="
            preview += str(len(args) - 1)
            preview += "]"
    if raw_kw:
        preview += "\n(kwargs keys: " + ",".join(sorted(raw_kw.keys())) + ")"
    return _truncate_for_llm_log(preview[: max_c + 400])


def _format_generation_output(gen_out, max_chars: int = 12000) -> str:
    try:
        gens = getattr(gen_out, "generations", None)
        if gens:
            chunks = []
            for bi, block in enumerate(gens):
                if not block:
                    continue
                texts = []
                for g in block:
                    txt = getattr(g, "text", None)
                    if txt is not None:
                        texts.append(txt)
                    else:
                        texts.append(str(g))
                chunks.append(f"[batch_prompt {bi}]\n" + "\n".join(texts))
            return _truncate_for_llm_log("\n\n".join(chunks)[:max_chars + 400])
    except Exception:
        pass
    return _truncate_for_llm_log(str(gen_out))


def _format_chat_result_output(out, max_chars: int = 12000) -> str:
    if hasattr(out, "content"):
        body = _message_content_piece(out)
        return _truncate_for_llm_log(body[: max_chars + 400])
    return _truncate_for_llm_log(_format_generation_output(out, max_chars=max_chars))


def _job_ctx_line(req) -> str:
    prov = getattr(req, "llm_provider", "?")
    mid = getattr(req, "job_id", None)
    model = (
        getattr(req, "openai_model", None)
        if prov == "openai"
        else getattr(req, "ollama_model", None)
    ) or "?"
    return f"job_id={mid} provider={prov} model={model}"


def _log_llm(phase: str, req, body: str) -> None:
    if not getattr(config, "LLM_DETAIL_LOG", False):
        return
    llm_logger.info("%s %s\n%s", phase, _job_ctx_line(req), body)


class _CountingLLMProxy:
    """Wrap LangChain chat model: usage accounting + optional detailed I/O logs."""

    __slots__ = ("_inner", "_req", "_track_tokens")

    def __init__(self, inner, req, *, track_tokens: bool):
        self._inner = inner
        self._req = req
        self._track_tokens = track_tokens

    def invoke(self, *args, **kwargs):
        _log_llm("llm.invoke_in", self._req, _format_invoke_args(args, kwargs))
        out = self._inner.invoke(*args, **kwargs)
        _log_llm("llm.invoke_out", self._req, _format_chat_result_output(out))
        pt, ct = (None, None)
        if self._track_tokens:
            pt, ct = _extract_usage_from_result(out)
        _maybe_record_llm_usage(self._req, pt, ct, calls=1)
        return out

    async def ainvoke(self, *args, **kwargs):
        _log_llm("llm.ainvoke_in", self._req, _format_invoke_args(args, kwargs))
        out = await self._inner.ainvoke(*args, **kwargs)
        _log_llm("llm.ainvoke_out", self._req, _format_chat_result_output(out))
        pt, ct = (None, None)
        if self._track_tokens:
            pt, ct = _extract_usage_from_result(out)
        _maybe_record_llm_usage(self._req, pt, ct, calls=1)
        return out

    def generate(self, messages, *args, **kwargs):
        _log_llm("llm.generate_in", self._req, _format_generate_messages(messages))
        out = self._inner.generate(messages, *args, **kwargs)
        _log_llm("llm.generate_out", self._req, _format_generation_output(out))
        pt, ct = (
            _extract_usage_from_result(out)
            if self._track_tokens
            else (None, None)
        )
        calls = len(messages) if isinstance(messages, list) else 1
        _maybe_record_llm_usage(self._req, pt, ct, calls=calls)
        return out

    async def agenerate(self, messages, *args, **kwargs):
        _log_llm("llm.agenerate_in", self._req, _format_generate_messages(messages))
        out = await self._inner.agenerate(messages, *args, **kwargs)
        _log_llm("llm.agenerate_out", self._req, _format_generation_output(out))
        pt, ct = (
            _extract_usage_from_result(out)
            if self._track_tokens
            else (None, None)
        )
        calls = len(messages) if isinstance(messages, list) else 1
        _maybe_record_llm_usage(self._req, pt, ct, calls=calls)
        return out

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _format_generate_messages(messages) -> str:
    max_c = getattr(config, "LLM_LOG_MAX_CHARS", 12000)
    if not isinstance(messages, list):
        return _truncate_for_llm_log(str(messages)[: max_c + 400])
    parts = []
    for i, seq in enumerate(messages):
        if isinstance(seq, list):
            bits = []
            for m in seq:
                bits.append(f"{type(m).__name__}:{_truncate_for_llm_log(_message_content_piece(m))}")
            parts.append(f"[prompt_set {i}]\n" + "\n".join(bits))
        else:
            parts.append(f"[prompt_set {i}]\n{_truncate_for_llm_log(str(seq))}")
    return _truncate_for_llm_log("\n\n".join(parts)[: max_c + 400])


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


def _normalize_contexts_cell(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
            return parsed if isinstance(parsed, list) else [parsed]
        except Exception:
            return [v]
    return [str(v)]


def _apply_column_map(row: dict, column_map: Optional[dict[str, str]]) -> dict:
    """
    Produce a canonical row with keys: question, contexts, ground_truth, answer (optional).
    column_map shape: canonical_key -> source_column_name
    """
    if not column_map:
        return row

    out: dict = {}
    for canon in ("question", "contexts", "ground_truth", "answer"):
        src = column_map.get(canon)
        if not src:
            continue
        out[canon] = row.get(src)
    return out


def read_tabular_rows(filepath: str, *, column_map: Optional[dict[str, str]] = None) -> list[dict]:
    if filepath.endswith(".csv"):
        df = pd.read_csv(filepath, dtype=str)
    elif filepath.endswith(".xlsx"):
        df = pd.read_excel(filepath, dtype=str)  # first sheet
    else:
        raise ValueError("Unsupported tabular file type.")

    rows: list[dict] = []
    for _, row in df.iterrows():
        r = row.to_dict()
        r = _apply_column_map(r, column_map)
        if "contexts" in r:
            r["contexts"] = _normalize_contexts_cell(r.get("contexts"))
        rows.append(r)
    return rows


def load_rows(filepath: str, *, column_map: Optional[dict[str, str]] = None) -> list[dict]:
    if filepath.endswith(".json"):
        with open(filepath) as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("results", [])

    return read_tabular_rows(filepath, column_map=column_map)


def build_llm(req):
    if req.llm_provider == "openai":
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings

        logger.info("llm_provider=openai model=%s", req.openai_model or "gpt-4o-mini")
        base_llm = ChatOpenAI(
            model=req.openai_model or "gpt-4o-mini",
            api_key=req.openai_api_key,
        )
        lc_llm = _CountingLLMProxy(base_llm, req, track_tokens=True)
        lc_emb = OpenAIEmbeddings(
            model="text-embedding-3-small",
            api_key=req.openai_api_key,
        )
        return LangchainLLMWrapper(lc_llm), LangchainEmbeddingsWrapper(lc_emb)

    from langchain_ollama import ChatOllama, OllamaEmbeddings

    base_url = normalize_ollama_base_url(req.ollama_base_url or "http://localhost:11434")
    model = req.ollama_model or "llama3.2"

    logger.info("llm_provider=ollama base_url=%s model=%s", base_url, model)
    base_llm = ChatOllama(model=model, base_url=base_url)
    lc_llm = _CountingLLMProxy(base_llm, req, track_tokens=False)
    lc_emb = OllamaEmbeddings(model=model, base_url=base_url)
    return LangchainLLMWrapper(lc_llm), LangchainEmbeddingsWrapper(lc_emb)


async def run_evaluation(
    filepath: str,
    req,
    *,
    is_disconnected: Optional[Callable[[], Awaitable[bool]]] = None,
    batch_size: int = 1,
) -> AsyncGenerator[str, None]:
    rows = load_rows(filepath, column_map=getattr(req, "column_map", None))
    if not rows:
        raise ValueError("No rows found in file.")

    cols = list(rows[0].keys())
    _, available = detect_format(cols)

    selected = [m for m in req.metrics if m in available]
    if not selected:
        raise ValueError("No applicable metrics for this file and selection.")

    logger.info(
        "evaluation_begin rows=%s metrics=%s batch_size=%s",
        len(rows),
        ",".join(selected),
        batch_size,
    )
    print(
        f"evaluation_begin rows={len(rows)} metrics={','.join(selected)} batch_size={batch_size}",
        flush=True,
    )
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
            logger.warning("evaluation_cancelled_by_client done=%s total=%s", batch_start, total)
            print(f"evaluation_cancelled done={batch_start} total={total}", flush=True)
            return

        batch_end = min(total, batch_start + batch_size)
        batch_samples = samples[batch_start:batch_end]

        t0 = time.time()
        logger.info("batch_begin start=%s end=%s", batch_start, batch_end)
        print(f"batch_begin start={batch_start} end={batch_end}", flush=True)

        metrics = [_new_metric(m) for m in selected]
        for m in metrics:
            m.llm = llm_wrapper
            if hasattr(m, "embeddings"):
                m.embeddings = emb_wrapper

        batch_dataset = EvaluationDataset(samples=batch_samples)
        result = evaluate(batch_dataset, metrics=metrics)
        df = result.to_pandas()
        logger.info("batch_end start=%s end=%s elapsed_s=%.2f", batch_start, batch_end, time.time() - t0)
        print(f"batch_end start={batch_start} end={batch_end} elapsed_s={time.time()-t0:.2f}", flush=True)

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

            payload = {
                "index": i,
                "question": rows[i].get("question", ""),
                "scores": scores,
                **_row_extra_fields(rows[i]),
            }
            yield _sse("row", payload)

    agg = {
        m: (round(sums[m] / counts[m], 4) if counts[m] else None)
        for m in selected
    }
    yield _sse("complete", {"aggregate": agg, "total": total})
    logger.info("evaluation_complete total=%s", total)
    print(f"evaluation_complete total={total}", flush=True)


def _sse(event: str, data: dict) -> str:
    import json as _json
    return f"event: {event}\ndata: {_json.dumps(data)}\n\n"
