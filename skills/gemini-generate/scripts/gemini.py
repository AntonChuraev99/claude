#!/usr/bin/env python3
"""Call the Gemini API with the key that Gemini CLI already stores.

Subcommands:
  models                       list models the key can call (free call)
  text  --model M -- PROMPT    answer a prompt with model M
  image --model M --out F -- PROMPT   generate or edit an image with model M

Every billed call prints its token usage and cost, and the running total for
today, from prices.json next to this script. The key is read from
GEMINI_API_KEY / GOOGLE_API_KEY or, on Windows, from the Credential Manager
entry that Gemini CLI writes. The key is never printed.
"""
import argparse
import base64
import datetime as dt
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://generativelanguage.googleapis.com/v1beta"
HERE = Path(__file__).resolve().parent
PRICES = HERE / "prices.json"
SPEND_LOG = Path(os.environ.get("GEMINI_SPEND_LOG", Path.home() / ".claude" / "stats" / "gemini-spend.jsonl"))
CRED_TARGET = "gemini-cli-api-key/default-api-key"


def die(msg, code):
    print(f"gemini-generate: {msg}", file=sys.stderr)
    sys.exit(code)


def read_windows_credential(target):
    """Read a generic credential blob from Windows Credential Manager."""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 ctypes.POINTER(ctypes.POINTER(CREDENTIAL))]
    advapi.CredReadW.restype = wintypes.BOOL
    advapi.CredFree.argtypes = [ctypes.c_void_p]
    pcred = ctypes.POINTER(CREDENTIAL)()
    if not advapi.CredReadW(target, 1, 0, ctypes.byref(pcred)):  # 1 = CRED_TYPE_GENERIC
        return None
    try:
        size = pcred.contents.CredentialBlobSize
        raw = bytes(pcred.contents.CredentialBlob[:size])
    finally:
        advapi.CredFree(pcred)
    # keytar-style stores write UTF-8; Windows tools often write UTF-16LE.
    for enc in ("utf-8", "utf-16-le"):
        try:
            text = raw.decode(enc).strip("\x00").strip()
        except UnicodeDecodeError:
            continue
        if text.isprintable() and text:
            return text
    return None


def api_key():
    # Strip: a key read from a file often ends with CR/LF, and http.client
    # would then raise ValueError with the full header value in its message.
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(name, "").strip():
            return os.environ[name].strip()
    stored = read_windows_credential(CRED_TARGET)
    if stored:
        # Gemini CLI writes {"serverName": ..., "token": {"accessToken": <key>,
        # "tokenType": "ApiKey"}, ...}; older tools may store the bare key.
        try:
            return str(json.loads(stored)["token"]["accessToken"]).strip()
        except (ValueError, KeyError, TypeError):
            return stored.strip()
    die("no API key: set GEMINI_API_KEY, or log in to Gemini CLI with an API key "
        f"(Windows Credential Manager entry '{CRED_TARGET}')", 4)


def call(method, path, body=None, timeout=300):
    try:
        req = urllib.request.Request(
            f"{API}/{path}", method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"x-goog-api-key": api_key(), "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        hint = ""
        if e.code == 429 and "free_tier" in str(detail) and "limit: 0," in str(detail):
            hint = ("\nThe key is on the free tier and this model has no free quota at all. "
                    "It works only after billing is enabled for the key's project in AI Studio.")
        elif e.code == 429 and "free_tier" in str(detail):
            hint = ("\nThe key is on the free tier and this model's free quota is used up. "
                    "Try another model or wait for the reset; paid use needs billing in AI Studio.")
        elif e.code == 429:
            hint = "\nRate limit or quota hit. Do not retry in a loop."
        die(f"HTTP {e.code}: {detail}{hint}", 5)
    except urllib.error.URLError as e:
        die(f"network error: {e.reason}", 5)
    except (TimeoutError, OSError) as e:
        die(f"network error while reading the answer: {type(e).__name__}", 5)
    except ValueError as e:
        # Never echo the message: http.client puts the header value (the key) in it.
        die(f"request or answer could not be processed ({type(e).__name__}); "
            "if it happens before any answer, check the API key format", 5)


# ---------- pricing ----------

def load_prices():
    try:
        return json.loads(PRICES.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        die(f"cannot read {PRICES}: {e}", 2)


def price_for(prices, model):
    """Exact id, or the id plus a version suffix ('-preview', '-latest', '-001',
    '-09-2026'). Longest match wins. Other suffixes ('-tts', '-image') are
    different products with other prices, so they stay unpriced."""
    best = None
    for mid in prices["models"]:
        rest = model[len(mid):] if model.startswith(mid) else None
        if rest == "" or (rest and re.fullmatch(r"-(preview|latest|\d[\d-]*)(-[\w.-]*)?", rest)
                          and not re.search(r"tts|image|live|audio|transcribe", rest)):
            if best is None or len(mid) > len(best):
                best = mid
    if not best:
        return None, None
    rate = dict(prices["models"][best])
    today = dt.date.today().isoformat()
    for when in sorted((rate.pop("changes", None) or {})):
        if when <= today:
            rate.update(prices["models"][best]["changes"][when])
    return best, rate


def split_tokens(usage):
    """Prompt, text-out (incl. thinking) and image-out token counts."""
    out = usage.get("candidatesTokenCount", 0)
    img_out = sum(d.get("tokenCount", 0) for d in usage.get("candidatesTokensDetails") or []
                  if d.get("modality") == "IMAGE")
    return {"prompt": usage.get("promptTokenCount", 0),
            "text_out": out - img_out + usage.get("thoughtsTokenCount", 0),
            "image_out": img_out}


def cost_of(usage, rate):
    """USD for one response. Rates are USD per 1M tokens."""
    tokens = split_tokens(usage)
    prompt, text_out, img_out = tokens["prompt"], tokens["text_out"], tokens["image_out"]
    tier = rate
    long_cut = rate.get("long_context_threshold")
    if long_cut and prompt > long_cut and "long_context" in rate:
        tier = {**rate, **rate["long_context"]}
    usd = (prompt * tier["input"] + text_out * tier["output"]
           + img_out * tier.get("image_output", tier["output"])) / 1_000_000
    return usd, tokens


def log_spend(model, usd, tokens):
    SPEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    row = {"ts": dt.datetime.now().isoformat(timespec="seconds"), "model": model,
           "usd": round(usd, 6) if usd is not None else None, **tokens}
    with SPEND_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def today_total():
    today = dt.date.today().isoformat()
    total, unknown = 0.0, 0
    try:
        lines = SPEND_LOG.read_text(encoding="utf-8").splitlines()
    except OSError:
        return total, unknown
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue  # one broken line must not drop the rest of the day
        if not isinstance(row, dict) or not str(row.get("ts", "")).startswith(today):
            continue
        if row.get("usd") is None:
            unknown += 1
        else:
            total += row["usd"]
    return total, unknown


def fmt_usd(usd):
    """Sub-cent amounts keep 6 decimals so a cheap call does not read as $0."""
    return f"${usd:.2f}" if usd >= 0.01 else f"${usd:.6f}"


def report(model, resp):
    usage = resp.get("usageMetadata") or {}
    prices = load_prices()
    mid, rate = price_for(prices, model)
    if rate:
        usd, tokens = cost_of(usage, rate)
        cost_line = fmt_usd(usd)
    else:
        usd = None
        tokens = split_tokens(usage)
        cost_line = f"unknown (no price for '{model}' in prices.json)"
    log_spend(model, usd, tokens)
    total, unknown = today_total()
    extra = f", {unknown} call(s) without price" if unknown else ""
    sys.stdout.flush()
    print(f"--- cost: {cost_line} | tokens: in {tokens['prompt']}, text out {tokens['text_out']}, "
          f"image out {tokens['image_out']} | today: {fmt_usd(total)}{extra} | "
          f"prices as of {prices.get('as_of', '?')}, list price: a free-tier key is not billed",
          file=sys.stderr)


# ---------- commands ----------

def read_prompt(args):
    if args.prompt_file:
        try:
            return Path(args.prompt_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            die(f"cannot read prompt file {args.prompt_file}: {type(e).__name__}", 2)
    text = " ".join(args.prompt).strip()
    if not text:
        die("prompt is empty: pass text after -- or --prompt-file", 2)
    return text


def inline_part(path):
    p = Path(path)
    if not p.is_file():
        die(f"file not found: {path}", 2)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(p.read_bytes()).decode()}}


def cmd_models(args):
    resp = call("GET", "models?pageSize=1000")
    for m in resp.get("models", []):
        methods = ",".join(m.get("supportedGenerationMethods", []))
        if args.all or "generateContent" in methods:
            print(f"{m['name'].removeprefix('models/'):45} {methods}")


def cmd_text(args):
    parts = [inline_part(f) for f in args.file] + [{"text": read_prompt(args)}]
    body = {"contents": [{"role": "user", "parts": parts}]}
    if args.system:
        body["systemInstruction"] = {"parts": [{"text": args.system}]}
    resp = call("POST", f"models/{args.model}:generateContent", body)
    cands = resp.get("candidates") or []
    text = "".join(p.get("text", "") for c in cands for p in (c.get("content") or {}).get("parts", []))
    if not text:
        reason = cands[0].get("finishReason") if cands else resp.get("promptFeedback")
        report(args.model, resp)
        die(f"empty answer (finish reason: {reason})", 6)
    print(text)
    report(args.model, resp)


def cmd_image(args):
    parts = [inline_part(f) for f in args.ref] + [{"text": read_prompt(args)}]
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}}
    if args.aspect or args.size:
        img_cfg = {}
        if args.aspect:
            img_cfg["aspectRatio"] = args.aspect
        if args.size:
            img_cfg["imageSize"] = args.size
        body["generationConfig"]["imageConfig"] = img_cfg
    resp = call("POST", f"models/{args.model}:generateContent", body)
    out = Path(args.out)
    saved, notes = [], []
    for c in resp.get("candidates") or []:
        for p in (c.get("content") or {}).get("parts", []):
            blob = p.get("inlineData") or p.get("inline_data")
            if blob and blob.get("data"):
                ext = mimetypes.guess_extension(blob.get("mimeType", "image/png")) or ".png"
                target = out if not saved else out.with_name(f"{out.stem}-{len(saved) + 1}{out.suffix or ext}")
                if not target.suffix:
                    target = target.with_suffix(ext)
                elif mimetypes.guess_type(target.name)[0] not in (None, blob.get("mimeType")):
                    print(f"gemini-generate: warning: model returned {blob.get('mimeType')}, "
                          f"saved as {target.name} without conversion", file=sys.stderr)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(blob["data"]))
                saved.append(target)
            elif p.get("text"):
                notes.append(p["text"])
    report(args.model, resp)
    if not saved:
        cands = resp.get("candidates") or []
        reason = cands[0].get("finishReason") if cands else resp.get("promptFeedback")
        die(f"no image in the answer (finish reason: {reason}). Model said: {' '.join(notes)[:500]}", 6)
    for s in saved:
        print(s)
    if notes:
        print("model note: " + " ".join(notes)[:500], file=sys.stderr)


def main():
    # Windows consoles default to a legacy code page; answers are often Cyrillic.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="gemini.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("models", help="list callable models (free)")
    m.add_argument("--all", action="store_true", help="include models without generateContent")
    m.set_defaults(fn=cmd_models)

    t = sub.add_parser("text", help="answer a prompt")
    t.add_argument("--model", required=True)
    t.add_argument("--system", help="system instruction")
    t.add_argument("--file", action="append", default=[], help="attach a file (image, PDF, ...); repeatable")
    t.add_argument("--prompt-file")
    t.add_argument("prompt", nargs=argparse.REMAINDER)
    t.set_defaults(fn=cmd_text)

    i = sub.add_parser("image", help="generate or edit an image")
    i.add_argument("--model", required=True)
    i.add_argument("--out", required=True, help="output path; more images get -2, -3 suffixes")
    i.add_argument("--ref", action="append", default=[], help="input image to edit or use as reference; repeatable")
    i.add_argument("--aspect", help="aspect ratio, e.g. 1:1, 16:9, 9:16")
    i.add_argument("--size", help="image size if the model supports it, e.g. 1K, 2K, 4K")
    i.add_argument("--prompt-file")
    i.add_argument("prompt", nargs=argparse.REMAINDER)
    i.set_defaults(fn=cmd_image)

    args = ap.parse_args()
    if getattr(args, "prompt", None) and args.prompt[:1] == ["--"]:
        args.prompt = args.prompt[1:]
    args.fn(args)


if __name__ == "__main__":
    main()
