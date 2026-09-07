#!/usr/bin/env python3
"""把菜單文字轉成一開就載入的連結：python3 menu_link.py <菜單txt>  → 印出 URL"""
import base64, sys
txt = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.read()
b = base64.urlsafe_b64encode(txt.encode("utf-8")).decode().rstrip("=")
print(f"https://online-menu-d4h.pages.dev/l2/#m={b}")
