const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { sendEmail } = require('./_email');

const ADMIN_NICK = process.env.ADMIN_NICK || 'eduardo';
const APP_URL = process.env.APP_URL || 'https://bolao-snip.vercel.app';

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      nick TEXT PRIMARY KEY,
      pass TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await Promise.all([
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT`.catch(() => {}),
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_token TEXT`.catch(() => {}),
  ]);
  return sql;
}

async function verifyAdmin(sql, adminNick, adminToken) {
  if (!adminNick || !adminToken) return false;
  const r = await sql`SELECT role FROM users WHERE nick = ${adminNick} AND token = ${adminToken}`;
  return r.length && r[0].role === 'admin';
}

function slugNick(name) {
  return (name || 'user')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'user';
}

async function findUniqueNick(sql, base) {
  let nick = base, i = 2;
  while (true) {
    const rows = await sql`SELECT 1 FROM users WHERE nick = ${nick}`;
    if (!rows.length) return nick;
    nick = `${base}${i++}`;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    if (req.method === 'GET' && action === 'config') {
      return res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
    }

    const sql = await getDb();

    if (req.method === 'POST' && action === 'google-login') {
      const { idToken } = req.body;
      if (!idToken) return res.status(400).json({ error: 'idToken obrigatório' });

      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!infoRes.ok) return res.status(401).json({ error: 'Token Google inválido' });
      const info = await infoRes.json();
      if (info.error || !info.sub) return res.status(401).json({ error: 'Token Google inválido' });

      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && info.aud !== clientId) return res.status(401).json({ error: 'Token Google inválido' });

      const googleId = info.sub;
      const email = (info.email || '').toLowerCase();
      const displayName = info.given_name || info.name || email.split('@')[0] || 'user';
      const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
      const isAdmin = !!(adminEmail && email === adminEmail);
      const token = crypto.randomUUID();

      let rows = await sql`SELECT nick, status, role FROM users WHERE google_id = ${googleId}`;
      if (!rows.length && email) {
        rows = await sql`SELECT nick, status, role FROM users WHERE email = ${email}`;
      }

      let user;
      if (rows.length) {
        user = rows[0];
        const status = isAdmin ? 'approved' : user.status;
        const role = isAdmin ? 'admin' : user.role;
        await sql`
          UPDATE users SET google_id = ${googleId}, token = ${token}, status = ${status}, role = ${role}, email = ${email || null}
          WHERE nick = ${user.nick}
        `;
        user = { nick: user.nick, status, role };
      } else {
        const nick = isAdmin ? ADMIN_NICK : await findUniqueNick(sql, slugNick(displayName));
        const status = isAdmin ? 'approved' : 'pending';
        const role = isAdmin ? 'admin' : 'user';
        const approvalToken = isAdmin ? null : crypto.randomUUID();
        await sql`
          INSERT INTO users (nick, email, google_id, token, status, role, approval_token)
          VALUES (${nick}, ${email || null}, ${googleId}, ${token}, ${status}, ${role}, ${approvalToken})
        `;
        user = { nick, status, role };

        if (!isAdmin && email && approvalToken) {
          const adminRows = await sql`SELECT email FROM users WHERE role = 'admin' LIMIT 1`;
          const notifyEmail = adminRows[0]?.email || process.env.ADMIN_EMAIL;
          if (notifyEmail) {
            const approveUrl = `${APP_URL}/api/auth?action=quick-approve&nick=${encodeURIComponent(nick)}&token=${encodeURIComponent(approvalToken)}`;
            sendEmail(notifyEmail, `🔔 Bolão Snip — Novo cadastro: ${nick}`, buildAdminNotifEmail(nick, email, approveUrl)).catch(() => {});
          }
        }
      }

      return res.status(200).json({ nick: user.nick, token, status: user.status, role: user.role });
    }

    if (req.method === 'GET' && action === 'status') {
      const { nick, token } = req.query;
      if (!nick || !token) return res.status(400).json({ error: 'nick e token obrigatórios' });
      const rows = await sql`SELECT status, role FROM users WHERE nick = ${nick} AND token = ${token}`;
      if (!rows.length) return res.status(401).json({ error: 'Sessão inválida' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'GET' && action === 'quick-approve') {
      const { nick, token } = req.query;
      if (!nick || !token) return res.status(400).send(htmlPage('Parâmetros inválidos', 'Link malformado.'));
      const rows = await sql`SELECT approval_token, status, email FROM users WHERE nick = ${nick}`;
      if (!rows.length) return res.status(404).send(htmlPage('Não encontrado', 'Usuário não encontrado.'));
      if (rows[0].status === 'approved') {
        return res.status(200).send(htmlPage('✅ Já aprovado', `${nick} já estava aprovado.`));
      }
      if (rows[0].approval_token !== token) {
        return res.status(403).send(htmlPage('Link inválido', 'Este link já foi utilizado ou é inválido.'));
      }
      await sql`UPDATE users SET status = 'approved', approval_token = NULL WHERE nick = ${nick}`;
      if (rows[0].email) {
        sendEmail(rows[0].email, '✅ Bolão Snip — Você foi aprovado!', buildApprovedEmail(nick)).catch(() => {});
      }
      return res.status(200).send(htmlPage('🎉 Aprovado!', `${nick} foi aprovado e já pode participar do bolão.`));
    }

    if (req.method === 'GET' && action === 'pending') {
      const { adminNick, adminToken } = req.query;
      if (!await verifyAdmin(sql, adminNick, adminToken)) return res.status(403).json({ error: 'Acesso negado' });
      const rows = await sql`SELECT nick, email, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at`;
      return res.status(200).json({ users: rows });
    }

    if (req.method === 'GET' && action === 'all') {
      const { adminNick, adminToken } = req.query;
      if (!await verifyAdmin(sql, adminNick, adminToken)) return res.status(403).json({ error: 'Acesso negado' });
      const rows = await sql`SELECT nick, email, status, role, created_at FROM users ORDER BY created_at`;
      return res.status(200).json({ users: rows });
    }

    if (req.method === 'POST' && action === 'approve') {
      const { adminNick, adminToken, targetNick, decision } = req.body;
      if (!await verifyAdmin(sql, adminNick, adminToken)) return res.status(403).json({ error: 'Acesso negado' });
      const newStatus = decision === 'approve' ? 'approved' : 'rejected';
      await sql`UPDATE users SET status = ${newStatus} WHERE nick = ${targetNick}`;
      if (decision === 'approve') {
        const userRows = await sql`SELECT email FROM users WHERE nick = ${targetNick}`;
        if (userRows[0]?.email) {
          sendEmail(userRows[0].email, '✅ Bolão Snip — Você foi aprovado!', buildApprovedEmail(targetNick)).catch(() => {});
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'delete') {
      const { adminNick, adminToken, targetNick } = req.body;
      if (!targetNick) return res.status(400).json({ error: 'targetNick obrigatório' });
      if (!await verifyAdmin(sql, adminNick, adminToken)) return res.status(403).json({ error: 'Acesso negado' });
      if (targetNick === ADMIN_NICK) return res.status(400).json({ error: 'Não é possível excluir o admin' });
      await sql`DELETE FROM palpites WHERE nick = ${targetNick}`;
      await sql`DELETE FROM users WHERE nick = ${targetNick}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Bolão Snip</title></head>
<body style="background:#0f0f0f;color:#f0f0f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px">
  <div>
    <div style="font-size:52px;margin-bottom:16px">${title.replace(/[A-Za-z0-9\s–\-!]/g, '') || '⚽'}</div>
    <h2 style="margin:0 0 8px;font-size:22px">${title}</h2>
    <p style="color:#999;font-size:14px;margin:0 0 24px">${message}</p>
    <a href="${APP_URL}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">Ir para o bolão</a>
  </div>
</body>
</html>`;
}

function buildAdminNotifEmail(nick, email, approveUrl) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f0f0f">
  <div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="margin-bottom:24px">
      <span style="font-size:28px">⚽</span>
      <span style="font-size:18px;font-weight:700;color:#f0f0f0;margin-left:8px">Bolão Snip - 2026</span>
    </div>
    <div style="background:#1a1a1a;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08)">
      <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#f0f0f0">Novo cadastro 🔔</p>
      <p style="margin:0 0 4px;font-size:14px;color:#999">Nick: <strong style="color:#f0f0f0">${nick}</strong></p>
      <p style="margin:0 0 20px;font-size:14px;color:#999">Google: <strong style="color:#f0f0f0">${email}</strong></p>
      <div style="text-align:center">
        <a href="${approveUrl}" style="display:inline-block;background:#1D9E75;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
          ✅ Aprovar acesso
        </a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#555;text-align:center">Se não reconhece esta pessoa, ignore este e-mail.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildApprovedEmail(nick) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f0f0f">
  <div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="margin-bottom:24px">
      <span style="font-size:28px">⚽</span>
      <span style="font-size:18px;font-weight:700;color:#f0f0f0;margin-left:8px">Bolão Snip - 2026</span>
    </div>
    <div style="background:#1a1a1a;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08)">
      <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#f0f0f0">Bem-vindo, ${nick}! 🎉</p>
      <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.5">
        Sua conta foi aprovada. Agora você pode fazer seus palpites no Bolão Snip!
      </p>
      <div style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#3b82f6;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
          Fazer palpites agora
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
