module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const orderId = req.query && req.query.orderId;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ paid: false });

  try {
    const hdr = { Authorization: 'Bearer ' + kvToken };
    const [paidResp, mapResp, cbResp, creditResp, metaResp, errResp] = await Promise.all([
      fetch(kvUrl + '/get/' + encodeURIComponent('order:paid:' + orderId), { headers: hdr }),
      fetch(kvUrl + '/get/' + encodeURIComponent('order:' + orderId), { headers: hdr }),
      fetch(kvUrl + '/get/' + encodeURIComponent('order:cb:' + orderId), { headers: hdr }),
      fetch(kvUrl + '/get/' + encodeURIComponent('order:credited:' + orderId), { headers: hdr }),
      fetch(kvUrl + '/get/' + encodeURIComponent('order:meta:' + orderId), { headers: hdr }),
      fetch(kvUrl + '/get/' + encodeURIComponent('order:error:' + orderId), { headers: hdr }),
    ]);

    const paid = await paidResp.json();
    const map  = await mapResp.json();
    const cb   = await cbResp.json();
    const cr   = await creditResp.json();
    const meta = await metaResp.json();
    const err  = await errResp.json();

    let metaObj = null;
    try { metaObj = meta.result ? JSON.parse(meta.result) : null; } catch (_) {}

    return res.status(200).json({
      paid: !!paid.result,
      mappedEmail: map.result ? decodeURIComponent(map.result) : null,
      callbackStatus: cb.result || null,
      credited: !!cr.result,
      meta: metaObj,
      error: err.result || null,
    });
  } catch (_) {
    return res.status(200).json({ paid: false });
  }
};
