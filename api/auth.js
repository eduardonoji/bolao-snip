import { kv } from "@vercel/kv";

const ADMIN_NICK = "eduardo";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // ── REGISTER ──────────────────────────────────────────────
  if (action === "register" && req.method === "POST") {
    const { nick, pass } = req.body;
    if (!nick || !pass) return res.status(400).json({ error: "Dados inválidos." });

    const slug = nick.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(slug))
      return res.status(400).json({ error: "Apelido inválido (2–20 chars, letras/números/_)." });

    const exists = await kv.hget("users", slug);
    if (exists) return res.status(409).json({ error: "Apelido já em uso." });

    const status = slug === ADMIN_NICK ? "approved" : "pending";
    const role   = slug === ADMIN_NICK ? "admin"    : "user";

    await kv.hset("users", {
      [slug]: JSON.stringify({ nick: slug, pass: Buffer.from(pass).toString("base64"), status, role })
    });

    return res.status(200).json({ ok: true, status, role });
  }

  // ── LOGIN ─────────────────────────────────────────────────
  if (action === "login" && req.method === "POST") {
    const { nick, pass } = req.body;
    const slug = (nick || "").trim().toLowerCase();
    const raw  = await kv.hget("users", slug);
    if (!raw) return res.status(404).json({ error: "Apelido não encontrado." });

    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (user.pass !== Buffer.from(pass).toString("base64"))
      return res.status(401).json({ error: "Senha incorreta." });

    return res.status(200).json({ ok: true, nick: user.nick, status: user.status, role: user.role });
  }

  // ── LIST PENDING (admin) ───────────────────────────────────
  if (action === "pending" && req.method === "GET") {
    const { adminNick, adminPass } = req.query;
    const ok = await checkAdmin(adminNick, adminPass);
    if (!ok) return res.status(403).json({ error: "Não autorizado." });

    const all = await kv.hgetall("users");
    const pending = Object.values(all || {})
      .map(v => (typeof v === "string" ? JSON.parse(v) : v))
      .filter(u => u.status === "pending")
      .map(u => ({ nick: u.nick, status: u.status }));

    return res.status(200).json({ pending });
  }

  // ── APPROVE / REJECT (admin) ───────────────────────────────
  if (action === "approve" && req.method === "POST") {
    const { adminNick, adminPass, targetNick, decision } = req.body;
    const ok = await checkAdmin(adminNick, adminPass);
    if (!ok) return res.status(403).json({ error: "Não autorizado." });

    const raw = await kv.hget("users", targetNick);
    if (!raw) return res.status(404).json({ error: "Usuário não encontrado." });

    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    user.status = decision === "approve" ? "approved" : "rejected";
    await kv.hset("users", { [targetNick]: JSON.stringify(user) });

    return res.status(200).json({ ok: true, status: user.status });
  }

  return res.status(404).json({ error: "Ação não encontrada." });
}

async function checkAdmin(nick, pass) {
  const slug = (nick || "").trim().toLowerCase();
  const raw  = await kv.hget("users", slug);
  if (!raw) return false;
  const user = typeof raw === "string" ? JSON.parse(raw) : raw;
  return user.role === "admin" && user.pass === Buffer.from(pass).toString("base64");
}
