#!/usr/bin/env python3
"""抓取 Anthropic news 页面正文（去标签提文本），供雷达简报用。用法: fetch_anthropic.py <slug>"""
import sys, re, html as h, urllib.request

slug = sys.argv[1]
url = f"https://www.anthropic.com/news/{slug}"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
try:
    raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
except Exception as e:
    print(f"FETCH_ERROR: {e}")
    sys.exit(0)
t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
t = re.sub(r"<[^>]+>", " ", t)
t = h.unescape(t)
t = re.sub(r"\s+", " ", t)
m = re.search(r"(.{0,200}(?:Today|announcing|Barclays|Academy).{0,3800})", t)
print(m.group(1) if m else t[:4000])
