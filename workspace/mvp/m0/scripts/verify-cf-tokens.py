#!/usr/bin/env python3
"""H-02: Cloudflare API トークン4本を .env から読んで検証する。

  python3 workspace/mvp/m0/scripts/verify-cf-tokens.py

トークン値は表示せず、ログにも出さない。判定と失効日だけを出力する。
GET の成功は「参照疎通」の証明であって Edit 権限の証明ではない（発行画面の一覧で別途確認すること）。

検証するもの:
  1. 各トークンが active か / 失効日はいつか
  2. 想定アカウントへ届くか（D1・Workers・KV。R2 は対象アカウントで有効な場合のみ）
  3. **アカウント境界** — ①のトークンが②へ届かないこと、②のトークンが①へ届かないこと
     ここが通らなければ H-14 案A の分離は成立していない。
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ROOT = pathlib.Path(__file__).resolve().parents[4]
ENV = ROOT / ".env"

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"

# (Secret名, 用途, 所属アカウントのキー, もう一方のアカウントのキー)
TOKENS = [
    ("TF_CLOUDFLARE_API_TOKEN",      "Terraform / アカウント①", "CLOUDFLARE_ACCOUNT_ID",      "CLOUDFLARE_ACCOUNT_ID_PROD"),
    ("CLOUDFLARE_API_TOKEN",         "CI       / アカウント①", "CLOUDFLARE_ACCOUNT_ID",      "CLOUDFLARE_ACCOUNT_ID_PROD"),
    ("TF_CLOUDFLARE_API_TOKEN_PROD", "Terraform / アカウント②", "CLOUDFLARE_ACCOUNT_ID_PROD", "CLOUDFLARE_ACCOUNT_ID"),
    ("CLOUDFLARE_API_TOKEN_PROD",    "CI       / アカウント②", "CLOUDFLARE_ACCOUNT_ID_PROD", "CLOUDFLARE_ACCOUNT_ID"),
]


def load_env(path):
    if not path.exists():
        sys.exit(f"{path} が無い")
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def call(token, path):
    """(success, payload) を返す。トークンは例外メッセージにも載せない。"""
    req = urllib.request.Request(f"{API}/{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except Exception:
            return False, {"errors": [{"message": f"HTTP {e.code}"}]}
    except Exception:
        return False, {"errors": [{"message": "接続失敗"}]}
    return bool(body.get("success")), body


def err_text(body):
    return "; ".join(str(e.get("message", "")) for e in (body.get("errors") or [])) or "unknown"


def main():
    env = load_env(ENV)
    missing = [n for n, *_ in TOKENS if not env.get(n)] + \
              [k for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PROD") if not env.get(k)]
    if missing:
        sys.exit(f"{ENV} に不足: {', '.join(missing)}")

    print(f"{DIM}.env から読み取り。トークン値は表示しない。{RESET}\n")
    ng = 0

    for name, role, own_key, other_key in TOKENS:
        token, own, other = env[name], env[own_key], env[other_key]
        print(f"== {name}  {DIM}({role}){RESET}")

        ok, body = call(token, "user/tokens/verify")
        result = body.get("result") or {}
        status = result.get("status", "invalid")
        if ok and status == "active":
            exp = result.get("expires_on") or "（無期限）"
            mark = GREEN + "OK " + RESET if result.get("expires_on") else YELLOW + "警告" + RESET
            print(f"  {mark} status=active  失効日={exp}")
            if not result.get("expires_on"):
                print(f"       {YELLOW}TTL が未設定。失効を既定にする方針に反する{RESET}")
                ng += 1
        else:
            print(f"  {RED}NG {RESET} status={status}  {err_text(body)}")
            ng += 1
            print()
            continue

        # 所属アカウントへ届くか
        for label, path, required in [
            ("Account Settings 参照", f"accounts/{own}",                        True),
            ("D1 一覧",               f"accounts/{own}/d1/database",            True),
            ("Workers Scripts 一覧",  f"accounts/{own}/workers/scripts",        True),
            ("KV 一覧",               f"accounts/{own}/storage/kv/namespaces",  True),
            ("R2 バケット一覧",        f"accounts/{own}/r2/buckets",             False),
        ]:
            ok, body = call(token, path)
            if ok:
                print(f"  {GREEN}OK {RESET} {label}")
            elif required:
                print(f"  {RED}NG {RESET} {label} -> {err_text(body)}")
                ng += 1
            else:
                print(f"  {DIM}--  {label}（任意。R2 未有効でも失敗する）{RESET}")

        # アカウント境界：もう一方へ届いてはいけない
        ok, body = call(token, f"accounts/{other}")
        if ok:
            print(f"  {RED}NG {RESET} 境界違反: もう一方のアカウントへ到達できてしまう")
            print(f"       {RED}Account Resources が All accounts になっている可能性。発行し直すこと{RESET}")
            ng += 1
        else:
            print(f"  {GREEN}OK {RESET} 境界: もう一方のアカウントへは到達しない")
        print()

    if ng:
        print(f"{RED}要対応 {ng} 件{RESET}")
        return 1
    print(f"{GREEN}4本すべて健全。アカウント境界も成立している。{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
