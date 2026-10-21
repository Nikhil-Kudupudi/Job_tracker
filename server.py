#!/usr/bin/env python3
"""
Job Tracker — local server.

  1. Serves the static app on http://127.0.0.1:5173
  2. POST /api/ai/parse   job description text -> structured fields
     GET  /api/ai/status  what the server is configured to use
     GET  /api/ai/models  what the key can reach (OpenAI-compatible only)

All model configuration and the API key live here, in .env. The browser
never sees a key, and providers do not need to send CORS headers.

Two providers:
  anthropic  — official SDK, JSON-schema structured outputs (needs `pip
               install anthropic`). Auto-selected for sk-ant-… keys.
  openai     — any OpenAI-compatible /chat/completions endpoint
               (Hugging Face router, Google AI Studio, Groq, Ollama).
               Stdlib only.

Run:  python server.py
"""

import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "5173"))
HOST = "127.0.0.1"          # localhost only — do not expose this

PARSE_PATH = "/api/ai/parse"
STATUS_PATH = "/api/ai/status"
MODELS_PATH = "/api/ai/models"
TIMEOUT = 180
MAX_CHARS = int(os.environ.get("AI_MAX_CHARS", "24000"))


# ════════════════════════════ configuration ════════════════════════════

def load_dotenv(path: Path) -> None:
    """Minimal .env reader: KEY=value per line, # comments, optional quotes."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:      # real env always wins
            os.environ[key] = value


def api_key() -> str:
    for name in ("ANTHROPIC_API_KEY", "AI_API_KEY", "GEMINI_API_KEY",
                 "GOOGLE_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def provider() -> str:
    explicit = os.environ.get("AI_PROVIDER", "").strip().lower()
    if explicit in ("anthropic", "openai"):
        return explicit
    if api_key().startswith("sk-ant-"):
        return "anthropic"
    # Read AI_MODEL directly, not via model(), which would recurse.
    if os.environ.get("AI_MODEL", "").strip().startswith("claude-"):
        return "anthropic"
    # Everything else — Gemini, Hugging Face, Groq, Ollama — goes through the
    # OpenAI-compatible path. Google serves one at /v1beta/openai/.
    return "openai"


def model() -> str:
    configured = os.environ.get("AI_MODEL", "").strip()
    if configured:
        return configured
    return "claude-haiku-4-5" if provider() == "anthropic" else ""


def upstream() -> str:
    return os.environ.get("AI_UPSTREAM_URL", "").strip()


def models_url() -> str:
    url = upstream()
    for suffix in ("/chat/completions", "/responses"):
        if url.endswith(suffix):
            return url[: -len(suffix)] + "/models"
    return url.rsplit("/", 1)[0] + "/models" if url else ""


def readiness() -> dict:
    """What the UI shows before anyone clicks Parse."""
    if not api_key():
        return {"ready": False, "reason":
                "No API key. Add one to the .env file next to server.py "
                "(see .env.example), then restart the server."}
    if provider() == "anthropic":
        if anthropic is None:
            return {"ready": False, "reason":
                    "The anthropic package is not installed. Run: pip install anthropic"}
        return {"ready": True, "reason": ""}
    if not upstream():
        return {"ready": False, "reason":
                "Set AI_UPSTREAM_URL in .env to your provider's "
                "/chat/completions endpoint."}
    if not model():
        return {"ready": False, "reason": "Set AI_MODEL in .env to a model id."}
    return {"ready": True, "reason": ""}


try:
    import anthropic
except ImportError:
    anthropic = None


# ════════════════════════════ the extraction ════════════════════════════

SYSTEM = """You extract structured data from job postings.

Rules:
- Extract only what the posting actually states. Use null when it is absent or unclear. Never guess, never infer from the company's reputation, never fill a field with a plausible default.
- "company" is the hiring employer, not a staffing agency posting on its behalf, and not the job board.
- "title" is the role title alone, stripped of location, req IDs, and employment type — "Senior Data Engineer, Remote (R12345)" becomes "Senior Data Engineer". Keep seniority words that belong to the title (Junior, Senior, Staff, Principal, Lead, I/II/III); they distinguish genuinely different roles.
- "location" is the primary city and region, e.g. "Boston, MA". For a fully remote role with no city, use "Remote". For several locations, take the first.
- "jobType" needs evidence. "Hybrid" requires an explicit mention of splitting time or required days on site. If the posting only names a city with no arrangement stated, return null rather than assuming.
- "experience" is the stated requirement, kept short and close to the source: "3+ years", "5-7 years", "Entry level".
- "skills" are concrete, named technical skills and tools — languages, frameworks, databases, platforms, methods. At most 12, most central first, in the posting's own spelling. Exclude soft skills, degrees, and generic phrases like "strong communication".
- "platform" is where this posting was found: "LinkedIn" only if the text clearly comes from LinkedIn, "Company site" if it is the employer's own careers page. Otherwise null.
- "url" only if an application URL appears literally in the text."""

SCHEMA = {
    "type": "object",
    "properties": {
        "company":    {"type": ["string", "null"]},
        "title":      {"type": ["string", "null"]},
        "location":   {"type": ["string", "null"]},
        "jobType":    {"type": ["string", "null"],
                       "enum": ["Remote", "Hybrid", "On site", None]},
        "experience": {"type": ["string", "null"]},
        "skills":     {"type": "array", "items": {"type": "string"}},
        "platform":   {"type": ["string", "null"],
                       "enum": ["LinkedIn", "Company site", None]},
        "url":        {"type": ["string", "null"]},
    },
    "required": ["company", "title", "location", "jobType", "experience",
                 "skills", "platform", "url"],
    "additionalProperties": False,
}

JOB_TYPES = ["Remote", "Hybrid", "On site"]
PLATFORMS = ["LinkedIn", "Company site"]
_EMPTYISH = {"null", "none", "n/a", "na", "not specified", "unspecified",
             "unknown", "not stated", "not mentioned", ""}


def user_prompt(text: str, known: dict) -> str:
    parts = []
    titles = (known or {}).get("titles") or []
    locations = (known or {}).get("locations") or []
    if titles:
        parts.append("Job titles already in the user's list. Reuse one verbatim "
                     "ONLY if it matches the posting's role AND its seniority "
                     "exactly; otherwise use the posting's own title. Never drop "
                     "a seniority word to force a match:\n" + ", ".join(titles[:60]))
    if locations:
        parts.append("Locations already in the list, same instruction:\n"
                     + ", ".join(locations[:60]))
    parts.append("Job posting:\n\n" + text)
    return "\n\n".join(parts)


def _str(value) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s.lower() in _EMPTYISH else s


def _one_of(value, allowed):
    v = _str(value).lower().replace(" ", "").replace("-", "").replace("_", "")
    for a in allowed:
        if a.lower().replace(" ", "") == v:
            return a
    return ""


def normalize(obj: dict) -> dict:
    """Belt and braces — the schema already constrains this, mostly."""
    raw_skills = obj.get("skills") or []
    if isinstance(raw_skills, str):
        raw_skills = raw_skills.replace(";", ",").split(",")

    skills, seen = [], set()
    for item in raw_skills:
        s = _str(item)
        if not s or len(s) > 40 or s.lower() in seen:
            continue
        seen.add(s.lower())
        skills.append(s)
        if len(skills) >= 12:
            break

    url = _str(obj.get("url"))
    if url and not url.lower().startswith(("http://", "https://")):
        url = ""

    return {
        "company": _str(obj.get("company")),
        "title": _str(obj.get("title")),
        "location": _str(obj.get("location")),
        "jobType": _one_of(obj.get("jobType"), JOB_TYPES),
        "experience": _str(obj.get("experience")),
        "skills": skills,
        "platform": _one_of(obj.get("platform"), PLATFORMS),
        "url": url,
    }


def extract_json(raw: str) -> dict:
    """Providers without schema support wrap JSON in prose or fences."""
    text = raw.strip()
    if "```" in text:
        start = text.find("```")
        fence_end = text.find("\n", start)
        close = text.find("```", fence_end)
        if fence_end != -1 and close != -1:
            text = text[fence_end:close].strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start:end + 1])
    raise ValueError("Could not read JSON out of the model's reply.")


# ── provider: Anthropic (official SDK, schema-enforced) ────────────────

def call_anthropic(text: str, known: dict) -> dict:
    client = anthropic.Anthropic(api_key=api_key())
    response = client.messages.create(
        model=model(),
        max_tokens=2048,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_prompt(text, known)}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )
    # output_config.format guarantees a text block holding valid JSON.
    body = next(b.text for b in response.content if b.type == "text")
    return json.loads(body)


# ── provider: any OpenAI-compatible endpoint (stdlib) ──────────────────

def call_openai(text: str, known: dict) -> dict:
    payload = {
        "model": model(),
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM +
             "\n\nReturn ONLY a JSON object matching this schema, no prose:\n"
             + json.dumps(SCHEMA)},
            {"role": "user", "content": user_prompt(text, known)},
        ],
    }

    def send(body: dict) -> dict:
        req = urllib.request.Request(
            upstream(), data=json.dumps(body).encode("utf-8"), method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key()}",
                # Some providers sit behind Cloudflare, which rejects the
                # default "Python-urllib/3.x" agent outright (error 1010).
                "User-Agent": "job-tracker/1.0",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read())

    try:
        data = send({**payload, "response_format": {"type": "json_object"}})
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        # Not every backend behind a router accepts response_format.
        if err.code == 400 and "response_format" in detail:
            data = send(payload)
        else:
            raise RuntimeError(f"Provider returned {err.code}: {detail[:300]}") from None

    return extract_json(data["choices"][0]["message"]["content"])


def parse_job(text: str, known: dict) -> dict:
    body = (text or "").strip()
    if len(body) < 40:
        raise ValueError("That is too short to parse — paste the full posting.")

    truncated = len(body) > MAX_CHARS
    payload = body[:MAX_CHARS] if truncated else body

    raw = (call_anthropic if provider() == "anthropic" else call_openai)(payload, known)
    return {"fields": normalize(raw), "truncated": truncated,
            "model": model(), "provider": provider()}


# ════════════════════════════ HTTP ════════════════════════════

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    # ── routes ────────────────────────────────────────────────────────
    def do_GET(self):                                   # noqa: N802
        path = self.path.rstrip("/")
        if path == STATUS_PATH:
            state = readiness()
            self.send_json(200, {**state, "provider": provider(), "model": model()})
            return
        if path == MODELS_PATH:
            if provider() == "anthropic":
                self.send_json(200, {"note":
                    "Anthropic model ids are fixed — set AI_MODEL in .env "
                    "(claude-haiku-4-5, claude-sonnet-5, claude-opus-5)."})
                return
            self.relay_models()
            return
        super().do_GET()

    def do_POST(self):                                  # noqa: N802
        if self.path.rstrip("/") != PARSE_PATH:
            self.send_json(404, {"error": f"No route for {self.path}"})
            return

        state = readiness()
        if not state["ready"]:
            self.send_json(503, {"error": state["reason"]})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length))
        except (ValueError, TypeError):
            self.send_json(400, {"error": "Request body is not valid JSON."})
            return

        try:
            self.send_json(200, parse_job(body.get("text", ""), body.get("known") or {}))
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except Exception as err:                        # noqa: BLE001
            self.send_json(502, {"error": friendly_error(err)})

    def relay_models(self) -> None:
        url = models_url()
        if not url:
            self.send_json(400, {"error": "No AI_UPSTREAM_URL set in .env."})
            return
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {api_key()}",
            "User-Agent": "job-tracker/1.0",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload = res.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except urllib.error.HTTPError as err:
            self.send_json(err.code, {"error": err.read().decode("utf-8", "replace")[:400]})
        except urllib.error.URLError as err:
            self.send_json(502, {"error": f"Could not reach the provider: {err.reason}"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def friendly_error(err: Exception) -> str:
    """Turn SDK and transport failures into something actionable."""
    if anthropic is not None:
        if isinstance(err, anthropic.AuthenticationError):
            return ("Anthropic rejected the API key. Check ANTHROPIC_API_KEY "
                    "in .env, then restart the server.")
        if isinstance(err, anthropic.NotFoundError):
            return (f"Model '{model()}' was not found. Set AI_MODEL in .env to "
                    "a valid id, e.g. claude-haiku-4-5.")
        if isinstance(err, anthropic.RateLimitError):
            return "Rate limited by Anthropic. Wait a moment and retry."
        if isinstance(err, anthropic.APIStatusError):
            if "credit balance is too low" in str(err.message):
                return ("Your Anthropic account has no credit. Add some under "
                        "Plans & Billing at console.anthropic.com — or switch to "
                        "a free provider by editing .env (Hugging Face and Google "
                        "AI Studio presets are in there, commented out).")
            return f"Anthropic returned {err.status_code}: {err.message}"
        if isinstance(err, anthropic.APIConnectionError):
            return "Could not reach Anthropic — check your network connection."
    return f"{type(err).__name__}: {err}"


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    # NOT allow_reuse_address on Windows: there SO_REUSEADDR lets a second
    # process bind a port another one is already listening on, so a stale
    # server keeps answering and you silently test old code. Failing to
    # start is the behaviour we want.
    allow_reuse_address = not sys.platform.startswith("win")


def main() -> None:
    load_dotenv(HERE / ".env")
    state = readiness()
    key = api_key()

    print(f"\n  Job Tracker  ->  http://{HOST}:{PORT}")
    print(f"  Provider     ->  {provider()}"
          + (f"  ({upstream()})" if provider() == "openai" and upstream() else ""))
    print(f"  Model        ->  {model() or '(not set)'}")
    print(f"  API key      ->  {f'{key[:8]}…{key[-4:]}' if key else 'MISSING'}")
    if state["ready"]:
        print("  Parsing      ->  ready")
    else:
        print(f"  Parsing      ->  DISABLED: {state['reason']}")
    print("\n  Ctrl+C to stop.\n")

    try:
        with Server((HOST, PORT), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
    except OSError as err:
        print(f"\n  Could not start on port {PORT}: {err}")
        print("  Something else is using it. Try:  PORT=5174 python server.py\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
