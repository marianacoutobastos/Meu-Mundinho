// Meu Mundinho - Cloudflare Pages Function
// Endpoint: GET /api/sync; PUT /api/sync
// D1 binding: DB; environment: ACCESS_TEAM_DOMAIN
// ACCESS_TEAM_DOMAIN example: sua-equipe.cloudflareaccess.com (without https://)
// All allowed Access users share ONE diary (as requested).

const ACCESS_AUD = 'e8173e2a4f5aa9a19563568f30d6cc49c16df549f12a8f742535e8e38af16da5';
const SHARED_USER = 'meu-mundinho-shared-v1';
const DATA_KEY = 'snapshot';
const MAX_BODY = 750_000;

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

function decode64url(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
function decodePart(value) {
  return JSON.parse(new TextDecoder().decode(decode64url(value)));
}

async function authenticate(request, env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '').trim()
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) {
    throw new Error('CONFIG_MISSING');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 10000) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    if (payload.iss !== `https://${domain}`) return false;
    if (!(Array.isArray(payload.aud) ? payload.aud.includes(ACCESS_AUD) : payload.aud === ACCESS_AUD)) return false;
    if (!Number.isFinite(payload.exp) || payload.exp <= now ||
        !Number.isFinite(payload.iat) || payload.iat > now + 60 ||
        (payload.nbf !== undefined && payload.nbf > now + 60)) return false;
    if (!payload.email || typeof payload.email !== 'string') return false;

    const certsResponse = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!certsResponse.ok) return false;
    const certs = await certsResponse.json();
    const jwk = certs.keys?.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey,
      decode64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!['GET', 'PUT'].includes(request.method)) {
    return json({ error: 'Método não permitido' }, 405);
  }
  if (!env.DB) return json({ error: 'Banco não configurado' }, 503);
  if (!env.ACCESS_TEAM_DOMAIN) return json({ error: 'Falta configurar ACCESS_TEAM_DOMAIN' }, 503);
  let authenticated;
  try { authenticated = await authenticate(request, env); }
  catch { return json({ error: 'Falha na configuração de autenticação' }, 503); }
  if (!authenticated) return json({ error: 'Sessão não autorizada' }, 401);

  if (request.method === 'GET') {
    const record = await env.DB.prepare(
      'SELECT data_json, updated_at FROM app_data WHERE user_id = ? AND data_key = ?'
    ).bind(SHARED_USER, DATA_KEY).first();
    if (!record) return json({ found: false, version: null });
    let data;
    try { data = JSON.parse(record.data_json); }
    catch { return json({ error: 'Dados armazenados inválidos' }, 500); }
    return json({ found: true, data, version: record.updated_at });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return json({ error: 'Envie JSON' }, 415);
  if (Number(request.headers.get('content-length')) > MAX_BODY) return json({ error: 'Arquivo muito grande' }, 413);
  let body;
  try { body = await request.text(); }
  catch { return json({ error: 'Não foi possível ler o envio' }, 400); }
  if (new TextEncoder().encode(body).length > MAX_BODY) return json({ error: 'Arquivo muito grande' }, 413);
  let payload;
  try { payload = JSON.parse(body); }
  catch { return json({ error: 'JSON inválido' }, 400); }
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data') ||
      (payload.baseVersion !== null && typeof payload.baseVersion !== 'string')) {
    return json({ error: 'Envie data e baseVersion (null na primeira gravação)' }, 400);
  }
  if (payload.data === null || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return json({ error: 'data precisa ser um objeto' }, 400);
  }
  const serialized = JSON.stringify(payload.data);
  if (new TextEncoder().encode(serialized).length > MAX_BODY) return json({ error: 'Dados muito grandes' }, 413);
  const version = new Date().toISOString() + '-' + crypto.randomUUID();
  let result;
  if (payload.baseVersion === null) {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO app_data (user_id, data_key, data_json, updated_at) VALUES (?, ?, ?, ?)'
    ).bind(SHARED_USER, DATA_KEY, serialized, version).run();
  } else {
    result = await env.DB.prepare(
      'UPDATE app_data SET data_json = ?, updated_at = ? WHERE user_id = ? AND data_key = ? AND updated_at = ?'
    ).bind(serialized, version, SHARED_USER, DATA_KEY, payload.baseVersion).run();
  }
  if (!result.meta?.changes) return json({ error: 'Conflito: há alterações mais recentes na nuvem. Recarregue antes de salvar.', conflict: true }, 409);
  return json({ saved: true, version });
}
