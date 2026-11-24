# DocuMind AI

An AI-based document understanding web app. Upload a PDF, DOCX or TXT file and get a summary, key points,
key information, a simple explanation, and answers to your questions. Powered by the Groq API.

- Backend: Python Flask (API key stays on the server, never in the browser)
- Frontend: HTML, CSS, JavaScript
- No database, no login. Uploaded files are temporary and deleted when you click **Remove**.

## Project structure
```
documind-ai/
├── app.py              # Flask backend (upload, text extraction, Groq calls)
├── requirements.txt
├── .env.example        # copy to .env and add your key
├── templates/index.html
├── static/css/style.css
├── static/js/app.js
└── uploads/            # temporary uploaded files
```

## Installation (Python 3.9+)

**Windows (Command Prompt / PowerShell)**
```
cd documind-ai
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

**macOS / Linux**
```
cd documind-ai
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then open `.env` and set your key (get one free at https://console.groq.com/keys):
```
GROQ_API_KEY=your_groq_api_key_here
```

## Run
```
python app.py
```
Open **http://127.0.0.1:3056** in your browser (the port comes from `PORT` in `.env`).

## How to use
1. Drag and drop a file (or click to browse).
2. Click **Summary**, **Key Points**, **Key Information**, **Simple Explanation**, or **Analyze all**.
3. Ask questions in the chat box. Use **Copy** on any result.
4. Click **Remove** to delete the file.

## Notes
- Limits: 10 MB per file; the first ~20,000 characters of a long document are analyzed.
- Scanned (image-only) PDFs have no extractable text and are rejected with a clear message.
- Default model is `openai/gpt-oss-120b`; change it with `GROQ_MODEL` in `.env`.
- Answers stream in word by word. For very long documents, Q&A sends the start of the file plus the passages that best match your question (`MAX_CHARS` in `.env` controls the size, default 20000).
- Security: `GROQ_API_KEY` is only read by `app.py` on the server. It never appears in any HTML, CSS or JS file. `.env` is listed in `.gitignore`; never commit or share it.
- If you see a rate-limit message, wait a few seconds and retry (free-tier limit).
