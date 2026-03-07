"""
translator-proxy — 翻译代理服务器
用户通过此服务器调用 DeepSeek API，按 token 计费，自动赚取差价

计费模型（可调整）:
  - DeepSeek V3 实际成本: ~¥3/M tokens (input+output 均价)
  - 对用户收费:           ¥10/M tokens
  - ¥10 充值 → 1,000,000 credits (1M credits = 1M tokens)
  - 净利润率: ~70%

支付: 虎皮椒 (xunhupay.com) 支持个人微信/支付宝
"""

import os, time, uuid, json, hashlib, hmac
import httpx
from typing import Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import aiosqlite

# ─── 配置（强制要求使用环境变量设定敏感参数）─────────────────────────────────────
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DB_PATH = os.getenv("DB_PATH", "translator.db")

# 虎皮椒支付配置 (https://www.xunhupay.com)
XUNHU_APPID = os.getenv("XUNHU_APPID")
XUNHU_APPSECRET = os.getenv("XUNHU_APPSECRET")
XUNHU_NOTIFY_URL = os.getenv("NOTIFY_URL")
XUNHU_RETURN_URL = os.getenv("RETURN_URL")

# 计费: 每消耗 1000 个预估 token 扣多少 credits
# 用户充值: ¥1 = 10000 credits
# ¥10 = 100000 credits = 10M estimated tokens → 实际 API 成本约 ¥3，利润 ~¥7
CREDITS_PER_CNY = 10_000          # ¥1 换 10000 credits
CREDITS_PER_1K_TOKENS = 1         # 每消耗 1K tokens 扣 1 credit
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Translator Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境改成 chrome-extension://
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── DB ────────────────────────────────────────────────────────────────────────
async def get_db():
    return await aiosqlite.connect(DB_PATH)

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id   TEXT PRIMARY KEY,
            credits   INTEGER NOT NULL DEFAULT 0,
            created   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ledger (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT    NOT NULL,
            delta       INTEGER NOT NULL,           -- 正=充值, 负=消费
            description TEXT,
            created     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orders (
            order_id    TEXT    PRIMARY KEY,
            user_id     TEXT    NOT NULL,
            amount_fen  INTEGER NOT NULL,           -- 分
            credits     INTEGER NOT NULL,
            status      TEXT    NOT NULL DEFAULT 'pending',
            created     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claims (
            claim_id    TEXT    PRIMARY KEY,
            user_id     TEXT    NOT NULL,
            amount_cny  INTEGER NOT NULL,
            credits     INTEGER NOT NULL,
            wechat_name TEXT    NOT NULL,
            status      TEXT    NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
            created     INTEGER NOT NULL
        );
        """)
        await db.commit()

@app.on_event("startup")
async def startup():
    await init_db()

# ── 工具函数 ──────────────────────────────────────────────────────────────────
def estimate_tokens(text: str) -> int:
    """简单估算 token 数（1 token ≈ 4 英文字符 或 1.5 中文字符）"""
    zh = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    en = len(text) - zh
    return int(zh * 0.7 + en * 0.25) + 50  # +50 prompt overhead

async def check_balance(db, user_id: str) -> int:
    async with db.execute("SELECT credits FROM users WHERE user_id=?", (user_id,)) as cur:
        row = await cur.fetchone()
        return row[0] if row else 0

async def ensure_user(db, user_id: str):
    await db.execute(
        "INSERT OR IGNORE INTO users (user_id, credits, created) VALUES (?,0,?)",
        (user_id, int(time.time()))
    )
    await db.commit()

async def deduct(db, user_id: str, tokens: int, description: str) -> bool:
    cost = max(1, tokens // 1000 * CREDITS_PER_1K_TOKENS)
    async with db.execute("SELECT credits FROM users WHERE user_id=?", (user_id,)) as cur:
        row = await cur.fetchone()
        if not row or row[0] < cost:
            return False
    await db.execute("UPDATE users SET credits=credits-? WHERE user_id=?", (cost, user_id))
    await db.execute(
        "INSERT INTO ledger(user_id,delta,description,created) VALUES(?,?,?,?)",
        (user_id, -cost, description, int(time.time()))
    )
    await db.commit()
    return True

# ── 查询余额 ──────────────────────────────────────────────────────────────────
@app.get("/api/balance/{user_id}")
async def balance(user_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_user(db, user_id)
        credits = await check_balance(db, user_id)
        # 换算成大约可翻译的字符数（每 credit = 1K tokens ≈ 4000 字符）
        approx_chars = credits * 1000 * 4
        return {"user_id": user_id, "credits": credits, "approx_chars": approx_chars}

# ── 翻译代理 ──────────────────────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    user_id: str
    text: str
    target_lang: str = "zh-Hans"
    model: str = "deepseek-chat"
    system_prompt: Optional[str] = None

@app.post("/api/translate")
async def translate(req: TranslateRequest):
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_user(db, req.user_id)
        credits = await check_balance(db, req.user_id)
        if credits <= 0:
            raise HTTPException(402, "credits_exhausted")

        # 调用 DeepSeek
        system = req.system_prompt or (
            f"你是专业翻译，将用户输入翻译为{req.target_lang}，"
            "只输出译文，不加解释，保留原有格式。"
        )
        payload = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": req.text},
            ],
            "temperature": 0.3,
            "max_tokens": 2000,
        }
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{DEEPSEEK_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}"},
                    json=payload,
                )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"upstream_error: {e.response.status_code}")
        except Exception as e:
            raise HTTPException(502, f"upstream_error: {e}")

        translated = data["choices"][0]["message"]["content"].strip()
        usage = data.get("usage", {})
        total_tokens = usage.get("total_tokens", estimate_tokens(req.text + translated))

        # 扣费
        await deduct(db, req.user_id, total_tokens, f"translate:{req.model}")

        # 返回译文 + 剩余余额
        new_credits = await check_balance(db, req.user_id)
        return {
            "translated": translated,
            "tokens_used": total_tokens,
            "credits_remaining": new_credits,
        }

# ── 创建充值订单 ──────────────────────────────────────────────────────────────
class TopupRequest(BaseModel):
    user_id: str
    amount_cny: int   # 元，最小 1

PACKAGES = {1: 10_000, 10: 110_000, 30: 350_000, 50: 620_000}
# ¥10 送 10% 额外，¥30 送 16%，¥50 送 24%

@app.post("/api/topup")
async def topup(req: TopupRequest):
    if req.amount_cny not in PACKAGES:
        raise HTTPException(400, "amount_cny must be one of: 1, 10, 30, 50")

    credits = PACKAGES[req.amount_cny]

    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_user(db, req.user_id)

    # 没有配置虎皮椒 → 走微信扫码人工验证流程
    if not XUNHU_APPID:
        return {
            "method": "manual_wechat",
            "amount_cny": req.amount_cny,
            "credits": credits,
        }

    order_id = "TR" + uuid.uuid4().hex[:16].upper()

    # 写入订单
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO orders(order_id,user_id,amount_fen,credits,status,created) VALUES(?,?,?,?,?,?)",
            (order_id, req.user_id, req.amount_cny * 100, credits, "pending", int(time.time()))
        )
        await db.commit()

    # 生成虎皮椒签名
    params = {
        "appid":      XUNHU_APPID,
        "out_trade_no": order_id,
        "total_fee":  str(req.amount_cny),
        "title":      f"翻译助手充值 ¥{req.amount_cny}",
        "notify_url": XUNHU_NOTIFY_URL,
        "return_url": XUNHU_RETURN_URL,
        "time":       str(int(time.time())),
        "nonce_str":  uuid.uuid4().hex[:16],
    }
    sign_str = "&".join(f"{k}={v}" for k, v in sorted(params.items()) if v) + "&key=" + XUNHU_APPSECRET
    params["hash"] = hashlib.md5(sign_str.encode()).hexdigest()

    # 向虎皮椒请求支付 URL
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post("https://api.xunhupay.com/payment/do.html", data=params)
        result = r.json()
    except Exception as e:
        raise HTTPException(502, f"payment_gateway_error: {e}")

    if result.get("errcode") != 0:
        raise HTTPException(502, result.get("errmsg", "payment_error"))

    return {
        "order_id":  order_id,
        "pay_url":   result["url"],
        "credits":   credits,
        "amount_cny": req.amount_cny,
    }

# ── 支付回调（虎皮椒 webhook）────────────────────────────────────────────────
@app.post("/api/payment/notify")
async def payment_notify(request: Request):
    form = await request.form()
    data = dict(form)

    # 验签
    sign = data.pop("hash", "")
    sign_str = "&".join(f"{k}={v}" for k, v in sorted(data.items()) if v) + "&key=" + XUNHU_APPSECRET
    expected = hashlib.md5(sign_str.encode()).hexdigest()
    if sign != expected:
        return {"errcode": -1, "errmsg": "sign error"}

    if data.get("status") != "OD":  # OD = 已支付
        return {"errcode": 0, "errmsg": "ok"}

    order_id = data.get("out_trade_no", "")
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT user_id, credits, status FROM orders WHERE order_id=?", (order_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            return {"errcode": -1, "errmsg": "order not found"}
        user_id, credits, status = row
        if status == "paid":
            return {"errcode": 0, "errmsg": "ok"}  # 防重复

        await db.execute("UPDATE orders SET status='paid' WHERE order_id=?", (order_id,))
        await db.execute("UPDATE users SET credits=credits+? WHERE user_id=?", (credits, user_id))
        await db.execute(
            "INSERT INTO ledger(user_id,delta,description,created) VALUES(?,?,?,?)",
            (user_id, credits, f"topup:order={order_id}", int(time.time()))
        )
        await db.commit()

    return {"errcode": 0, "errmsg": "ok"}

# ── 手动支付凭证提交（用户扫码付款后提交微信昵称）─────────────────────────
class ClaimRequest(BaseModel):
    user_id: str
    amount_cny: int
    wechat_name: str   # 用户付款时的微信昵称

@app.post("/api/claim")
async def submit_claim(req: ClaimRequest):
    if req.amount_cny not in PACKAGES:
        raise HTTPException(400, "invalid amount")
    credits = PACKAGES[req.amount_cny]
    claim_id = "CLM" + uuid.uuid4().hex[:12].upper()
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_user(db, req.user_id)
        await db.execute(
            "INSERT INTO claims(claim_id,user_id,amount_cny,credits,wechat_name,status,created) VALUES(?,?,?,?,?,?,?)",
            (claim_id, req.user_id, req.amount_cny, credits, req.wechat_name, "pending", int(time.time()))
        )
        await db.commit()
    return {"ok": True, "claim_id": claim_id, "message": "已收到，通常5分钟内验证到账"}

# ── 管理接口（内部用，加 secret 保护）────────────────────────────────────────
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "changeme")

@app.get("/admin/claims")
async def list_claims(secret: str = ""):
    if secret != ADMIN_SECRET:
        raise HTTPException(403)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT claim_id, user_id, amount_cny, credits, wechat_name, status, created FROM claims ORDER BY created DESC LIMIT 50"
        ) as cur:
            rows = await cur.fetchall()
    return [{"claim_id": r[0], "user_id": r[1], "amount_cny": r[2], "credits": r[3],
             "wechat_name": r[4], "status": r[5], "time": time.strftime('%m-%d %H:%M', time.localtime(r[6]))} for r in rows]

@app.post("/admin/approve-claim")
async def approve_claim(request: Request):
    data = await request.json()
    if data.get("secret") != ADMIN_SECRET:
        raise HTTPException(403)
    claim_id = data["claim_id"]
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT user_id, credits, status FROM claims WHERE claim_id=?", (claim_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "claim not found")
        user_id, credits, status = row
        if status == "approved":
            return {"ok": True, "message": "already approved"}
        await db.execute("UPDATE claims SET status='approved' WHERE claim_id=?", (claim_id,))
        await db.execute("UPDATE users SET credits=credits+? WHERE user_id=?", (credits, user_id))
        await db.execute(
            "INSERT INTO ledger(user_id,delta,description,created) VALUES(?,?,?,?)",
            (user_id, credits, f"claim:{claim_id}", int(time.time()))
        )
        await db.commit()
    return {"ok": True, "user_id": user_id, "credits_added": credits}

@app.post("/admin/grant")
async def admin_grant(request: Request):
    data = await request.json()
    if data.get("secret") != ADMIN_SECRET:
        raise HTTPException(403)
    user_id = data["user_id"]
    credits = int(data["credits"])
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_user(db, user_id)
        await db.execute("UPDATE users SET credits=credits+? WHERE user_id=?", (credits, user_id))
        await db.execute(
            "INSERT INTO ledger(user_id,delta,description,created) VALUES(?,?,?,?)",
            (user_id, credits, "admin_grant", int(time.time()))
        )
        await db.commit()
    return {"ok": True, "credits_added": credits}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
