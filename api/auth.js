module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  const action = req.body && req.body.action;
  const uid = req.body && req.body.uid;
  const pass = req.body && req.body.pass;
  if (!uid || typeof uid !== 'string') return res.status(400).json({ success: false, error: 'missing uid' });
  if (!pass || pass.length < 4) return res.status(400).json({ success: false, error: 'password too short' });
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ success: false, error: 'KV not configured' });
  try {
    const key = 'pass_' + uid;
    if (action === 'bind') {
      const r = await fetch(kvUrl + '/get/' + key, { headers: { Authorization: 'Bearer ' + kvToken } });
      const d = await r.json();
      if (d.result) return res.status(200).json({ success: false, error: 'already bound' });
      await fetch(kvUrl + '/set/' + key + '/' + pass, { headers: { Authorization: 'Bearer ' + kvToken } });
      return res.status(200).json({ success: true });
    } else if (action === 'recover') {
      const r = await fetch(kvUrl + '/get/' + key, { headers: { Authorization: 'Bearer ' + kvToken } });
      const d = await r.json();
      if (!d.result) return res.status(200).json({ success: false, error: 'not found' });
      if (String(d.result) !== pass) return res.status(200).json({ success: false, error: 'wrong password' });
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ success: false, error: 'unknown action' });
  } catch(e) {
    return res.status(200).json({ success: false, error: e.message });
  }
};
