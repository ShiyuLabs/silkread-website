// api/admin-dashboard.js — 私有管理后台数据接口
// 需要在 Vercel 环境变量中设置 ADMIN_SECRET
// 调用方式：POST /api/admin-dashboard  Body: { secret, action, ...params }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(500).json({ error: '未配置 ADMIN_SECRET 环境变量' });

  const { secret, action } = req.body || {};
  if (!secret || secret !== adminSecret) {
    return res.status(403).json({ error: '密码错误' });
  }

  const kvUrl     = process.env.KV_REST_API_URL;
  const kvToken   = process.env.KV_REST_API_TOKEN;
  const kvHeaders = { Authorization: 'Bearer ' + kvToken };

  // ── 获取用户列表 ──────────────────────────────────────────────────────────
  if (action === 'list_users') {
    try {
      // SCAN 找出所有 user:*:credits 键
      let cursor = '0';
      const allKeys = [];
      do {
        const r = await fetch(
          `${kvUrl}/scan/${cursor}?match=${encodeURIComponent('user:*:credits')}&count=200`,
          { headers: kvHeaders }
        );
        const d = await r.json();
        cursor = String(d.result[0]);
        allKeys.push(...d.result[1]);
      } while (cursor !== '0');

      if (allKeys.length === 0) {
        return res.status(200).json({ users: [], totalUsers: 0, totalCredits: 0 });
      }

      // MGET 批量取余额
      const mgetPath = '/mget/' + allKeys.map(k => encodeURIComponent(k)).join('/');
      const mr = await fetch(kvUrl + mgetPath, { headers: kvHeaders });
      const md = await mr.json();

      const users = allKeys.map((key, i) => {
        const email   = key.replace(/^user:/, '').replace(/:credits$/, '');
        const credits = parseInt(md.result[i] || '0', 10);
        return { email, credits };
      });

      users.sort((a, b) => b.credits - a.credits);
      const totalCredits = users.reduce((s, u) => s + u.credits, 0);

      return res.status(200).json({
        users,
        totalUsers:   users.length,
        totalCredits,
        ts: Date.now(),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 修改用户余额 ──────────────────────────────────────────────────────────
  if (action === 'set_credits') {
    const { email, credits } = req.body;
    if (!email || credits === undefined) return res.status(400).json({ error: '缺少参数' });
    const key = encodeURIComponent('user:' + email.toLowerCase().trim() + ':credits');
    const r = await fetch(`${kvUrl}/set/${key}/${parseInt(credits, 10)}`, { headers: kvHeaders });
    const d = await r.json();
    return res.status(200).json({ ok: true, result: d.result });
  }

  // ── 增加用户积分 ──────────────────────────────────────────────────────────
  if (action === 'add_credits') {
    const { email, amount } = req.body;
    if (!email || !amount) return res.status(400).json({ error: '缺少参数' });
    const key = encodeURIComponent('user:' + email.toLowerCase().trim() + ':credits');
    const r = await fetch(`${kvUrl}/incrby/${key}/${parseInt(amount, 10)}`, { headers: kvHeaders });
    const d = await r.json();
    return res.status(200).json({ ok: true, newTotal: d.result });
  }

  return res.status(400).json({ error: '未知 action' });
};
