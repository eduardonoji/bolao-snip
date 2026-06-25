async function getGmailAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    }),
  });
  if (!r.ok) throw new Error('Gmail token refresh failed: ' + await r.text());
  const { access_token } = await r.json();
  return access_token;
}

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail(to, subject, html) {
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.log(`[email] GMAIL_REFRESH_TOKEN não configurado — e-mail para ${to} ignorado`);
    return false;
  }
  try {
    const fromName = `=?UTF-8?B?${Buffer.from('Bolão Snip').toString('base64')}?=`;
    const from = `${fromName} <${process.env.ADMIN_EMAIL || 'me'}>`;
    const appUrl = process.env.APP_URL || 'https://bolao-snip.vercel.app';
    const accessToken = await getGmailAccessToken();

    const boundary = `----_bolaosnip_${Date.now()}`;
    const text = htmlToText(html);

    const raw = Buffer.from(
      `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `List-Unsubscribe: <${appUrl}>\r\n` +
      `List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n` +
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `\r\n` +
      text + `\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `\r\n` +
      html + `\r\n` +
      `--${boundary}--`
    ).toString('base64url');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      console.error(`[email] Erro ao enviar para ${to}:`, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] Exceção:', e.message, e.cause || '');
    return false;
  }
}

module.exports = { sendEmail };
