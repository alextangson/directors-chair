"""Re-run the 11-06 official Gemini listening blind test on newer models.

Same samples and prompt as official-blindtest-v002 (gemini-3.1-pro-preview), so results compare.
Usage: python3 -I gemini_listen_exam.py <exam_dir> <out_dir> <model> [<model> ...]
"""
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RUNS = 2
SUFFIX = "\n全片约40秒。回答控制在800个汉字内。issues中每项使用start_s,end_s,phenomenon,confidence,recommendation。请把音乐、物件音效、讲话分别处理。不要输出思考过程。"


def api_key() -> str:
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    z = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", "codex", "-s", "official-gemini-audio", "-w"],
                       capture_output=True, text=True)
    if z.returncode != 0:
        sys.exit("official-gemini-audio key not readable from keychain")
    return z.stdout.strip()


def call(key: str, model: str, prompt: str, audio: Path) -> dict:
    body = {"contents": [{"role": "user", "parts": [
        {"text": prompt},
        {"inlineData": {"mimeType": "audio/flac", "data": base64.b64encode(audio.read_bytes()).decode()}}]}]}
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read())
            status = r.status
    except urllib.error.HTTPError as e:
        return {"http_status": e.code, "error": e.read().decode()[:2000], "seconds": round(time.time() - t0, 1)}
    except Exception as e:  # network/timeout: record, never drop silently
        return {"http_status": None, "error": repr(e), "seconds": round(time.time() - t0, 1)}
    text = "".join(p.get("text", "") for c in data.get("candidates", []) for p in c.get("content", {}).get("parts", []))
    return {"http_status": status, "modelVersion": data.get("modelVersion"), "usage": data.get("usageMetadata"),
            "finish": [c.get("finishReason") for c in data.get("candidates", [])], "text": text,
            "seconds": round(time.time() - t0, 1)}


def main() -> None:
    exam, out, models = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    prompt = (exam / "prompt.txt").read_text() + SUFFIX
    samples = sorted(exam.glob("sample-*.flac"))
    key = api_key()
    jobs = [(m, r, s) for m in models for r in range(1, RUNS + 1) for s in samples]

    def run(job):
        m, r, s = job
        dest = out / m / f"run{r}" / f"{s.stem}.json"
        if dest.exists():
            return f"skip {dest}"
        res = call(key, m, prompt, s)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"model": m, "run": r, "sample": s.stem, **res}, ensure_ascii=False, indent=2))
        return f"{m} run{r} {s.stem} http={res.get('http_status')} {res.get('seconds')}s {res.get('error', '')[:120]}"

    with ThreadPoolExecutor(4) as pool:
        for line in pool.map(run, jobs):
            print(line, flush=True)


if __name__ == "__main__":
    main()
