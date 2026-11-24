"""DocuMind AI - upload a document, understand it with Groq. No database, no login."""
import json
import os
import re
import uuid
from pathlib import Path

import requests
from docx import Document
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from pypdf import PdfReader

load_dotenv()

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED = {".pdf", ".docx", ".txt"}
MAX_MB = 10
MAX_CHARS = int(os.getenv("MAX_CHARS", "20000"))  # characters of document text sent to the AI
GROQ_URL = os.getenv("GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions")
MODEL = (os.getenv("GROQ_MODEL") or "openai/gpt-oss-120b").strip()
IS_REASONING = "gpt-oss" in MODEL  # reasoning models need extra settings (see groq_request)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_MB * 1024 * 1024

DOCS = {}  # doc_id -> {"name", "path", "text"}  (in memory only)

# Uploaded files are temporary: wipe leftovers from any previous run.
for old in UPLOAD_DIR.iterdir():
    if old.name != ".gitkeep":
        old.unlink(missing_ok=True)


# ---------- helpers ----------
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(413)
def too_large(_):
    return jsonify(error=f"File is too large. Maximum size is {MAX_MB} MB."), 413


@app.errorhandler(Exception)
def handle_unexpected(e):
    if hasattr(e, "code") and isinstance(e.code, int):  # normal HTTP errors (404, 405...)
        return jsonify(error=getattr(e, "description", "Request failed.")), e.code
    app.logger.exception(e)
    return jsonify(error="Something went wrong on the server. Please try again."), 500


def extract_text(path: Path, ext: str) -> str:
    try:
        if ext == ".pdf":
            reader = PdfReader(str(path))
            if reader.is_encrypted:
                reader.decrypt("")
            return "\n".join((p.extract_text() or "") for p in reader.pages)
        if ext == ".docx":
            doc = Document(str(path))
            parts = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(c.text.strip() for c in row.cells))
            return "\n".join(parts)
        raw = path.read_bytes()
        try:
            return raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return raw.decode("latin-1")
    except Exception:
        raise ApiError("Could not read this file. It may be corrupted or password protected.", 422)


def get_doc(doc_id):
    doc = DOCS.get(doc_id)
    if not doc:
        raise ApiError("Document not found. Please upload it again.", 404)
    return doc


def groq_request(messages, max_tokens=4096, stream=False):
    """Send a chat request to Groq. The API key is read from .env and never leaves the server."""
    key = (os.getenv("GROQ_API_KEY") or "").strip()
    if not key or key == "your_groq_api_key_here":
        raise ApiError("GROQ_API_KEY is missing. Add it to your .env file and restart the server.", 500)
    body = {"model": MODEL, "messages": messages, "temperature": 0.3,
            "max_completion_tokens": max_tokens, "stream": stream}
    if IS_REASONING:
        # gpt-oss "thinks" before answering and thinking tokens count toward the limit:
        # low effort keeps answers fast and stops replies from being cut off or empty.
        body["reasoning_effort"] = "low"
        body["include_reasoning"] = False
    try:
        r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json=body, timeout=90, stream=stream)
    except requests.Timeout:
        raise ApiError("The AI took too long to respond. Please try again.", 504)
    except requests.RequestException:
        raise ApiError("Could not reach the Groq API. Check your internet connection.", 502)

    if r.status_code == 401:
        raise ApiError("Invalid Groq API key. Check GROQ_API_KEY in your .env file.", 401)
    if r.status_code == 429:
        raise ApiError("Groq rate limit reached. Please wait a few seconds and try again.", 429)
    if not r.ok:
        try:
            detail = r.json()["error"]["message"]
        except Exception:
            detail = ""
        raise ApiError(f"Groq API error ({r.status_code}). {detail}".strip(), 502)
    return r


def call_groq(messages, max_tokens=4096):
    r = groq_request(messages, max_tokens)
    try:
        text = (r.json()["choices"][0]["message"].get("content") or "").strip()
    except Exception:
        raise ApiError("Unexpected response from the AI. Please try again.", 502)
    if not text:
        raise ApiError("The AI returned an empty answer. Please try again.", 502)
    return text


def stream_answer(messages, max_tokens=4096):
    """Return a streamed plain-text Response so answers appear word by word."""
    r = groq_request(messages, max_tokens, stream=True)  # errors are raised BEFORE streaming starts
    r.encoding = "utf-8"

    def generate():
        got_text = False
        try:
            for line in r.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    delta = json.loads(payload)["choices"][0].get("delta", {}).get("content")
                except (ValueError, KeyError, IndexError):
                    continue
                if delta:
                    got_text = True
                    yield delta
        except requests.RequestException:
            yield "\n\n⚠ Connection lost while the answer was streaming." if got_text else ""
        finally:
            r.close()
        if not got_text:
            yield "⚠ The AI returned an empty answer. Please try again."

    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


WORD = re.compile(r"[a-z0-9]{3,}")


def pick_text(full, question=None):
    """Whole document if it fits; otherwise the start plus the passages that best match the question."""
    if len(full) <= MAX_CHARS:
        return full, False
    head = full[: MAX_CHARS // 4]
    if not question:
        return full[:MAX_CHARS], True
    terms = set(WORD.findall(question.lower()))
    size, rest = 1200, full[len(head):]
    chunks = [rest[i:i + size] for i in range(0, len(rest), size)]
    scored = sorted(range(len(chunks)), key=lambda i: -len(terms & set(WORD.findall(chunks[i].lower()))))
    budget, chosen = MAX_CHARS - len(head), []
    for i in scored:
        if len(chunks[i]) > budget:
            break
        if terms & set(WORD.findall(chunks[i].lower())):
            chosen.append(i)
            budget -= len(chunks[i])
    return head + "\n[...]\n" + "\n[...]\n".join(chunks[i] for i in sorted(chosen)), True


def doc_context(doc, question=None):
    text, cut = pick_text(doc["text"], question)
    note = "\n[Note: this is a long document; only the most relevant parts are shown.]" if cut else ""
    return f"DOCUMENT NAME: {doc['name']}\n\nDOCUMENT TEXT:\n{text}{note}"


SYSTEM = (
    "You are DocuMind AI, an expert document analyst. Use ONLY the document provided. "
    "Never invent facts. Reply in clean Markdown (short paragraphs, bullet lists, **bold** for key terms)."
)

TASKS = {
    "summary": "Write a clear, concise summary of this document: start with a 2-3 sentence overview, "
               "then a short list of the main sections or ideas.",
    "keypoints": "List the 6-10 most important key points of this document as short bullet points.",
    "info": "Extract the important information from this document and group it under bold headings "
            "such as People, Organizations, Dates, Amounts/Numbers, Locations, Deadlines, Terms/Definitions. "
            "Skip any group that has nothing. Use bullet lists.",
    "simple": "Explain the content of this document in very simple language, as if to a beginner. "
              "Avoid jargon; if you must use a technical term, explain it briefly. Use short sentences and an everyday example if it helps.",
}


# ---------- routes ----------
@app.get("/")
def index():
    return render_template("index.html", max_mb=MAX_MB)


@app.post("/api/upload")
def upload():
    file = request.files.get("file")
    if not file or not file.filename:
        raise ApiError("No file received. Please choose a file to upload.")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED:
        raise ApiError("Unsupported file type. Please upload a PDF, DOCX, or TXT file.", 415)

    doc_id = uuid.uuid4().hex
    path = UPLOAD_DIR / f"{doc_id}{ext}"
    try:
        file.save(path)
    except Exception:
        raise ApiError("Upload failed while saving the file. Please try again.", 500)

    try:
        text = extract_text(path, ext).strip()
    except ApiError:
        path.unlink(missing_ok=True)
        raise
    if not text:
        path.unlink(missing_ok=True)
        raise ApiError("No readable text found. The document is empty or may be a scanned image.", 422)

    DOCS[doc_id] = {"name": file.filename, "path": path, "text": text}
    return jsonify(id=doc_id, name=file.filename, words=len(text.split()), chars=len(text),
                   truncated=len(text) > MAX_CHARS)


@app.post("/api/analyze")
def analyze():
    data = request.get_json(silent=True) or {}
    doc = get_doc(data.get("doc_id"))
    task = data.get("task")
    if task not in TASKS:
        raise ApiError("Unknown analysis type.")
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"{doc_context(doc)}\n\nTASK: {TASKS[task]}"},
    ]
    if data.get("stream"):
        return stream_answer(messages)
    return jsonify(result=call_groq(messages))


@app.post("/api/ask")
def ask():
    data = request.get_json(silent=True) or {}
    doc = get_doc(data.get("doc_id"))
    question = (data.get("question") or "").strip()
    if not question:
        raise ApiError("Please type a question.")
    if len(question) > 1000:
        raise ApiError("Question is too long (max 1000 characters).")
    history = [
        {"role": m["role"], "content": str(m["content"])[:2000]}
        for m in (data.get("history") or [])[-6:]
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
    ]
    messages = [
        {"role": "system", "content": SYSTEM + " Answer the user's questions about this document. "
         "If the answer is not in the document, say so clearly.\n\n" + doc_context(doc, question)},
        *history,
        {"role": "user", "content": question},
    ]
    if data.get("stream"):
        return stream_answer(messages)
    return jsonify(answer=call_groq(messages))


@app.delete("/api/document/<doc_id>")
def remove(doc_id):
    doc = DOCS.pop(doc_id, None)
    if doc:
        doc["path"].unlink(missing_ok=True)
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int((os.getenv("PORT") or "5000").strip()), debug=False, threaded=True)
