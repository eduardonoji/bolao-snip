# ⚽ Bolão Copa 2026

App de bolão para a Copa do Mundo 2026 com aprovação de admin, palpites e ranking em tempo real.

## Tecnologias
- Frontend: HTML/CSS/JS puro (sem framework)
- Backend: Vercel Serverless Functions (Node.js)
- Banco de dados: Vercel KV (Redis gerenciado, free tier)
- Placares: API worldcup26.ir (gratuita)

---

## Deploy na Vercel — passo a passo

### 1. Crie um repositório no GitHub
```bash
git init
git add .
git commit -m "Bolão Copa 2026"
gh repo create bolao-copa-2026 --public --push
```
Ou suba manualmente em github.com → New repository → upload dos arquivos.

### 2. Importe na Vercel
- Acesse vercel.com/new
- Conecte seu GitHub e selecione o repositório
- Clique em **Deploy** (sem alterar nada nas configurações)

### 3. Configure o Vercel KV
Após o deploy inicial:
1. No painel da Vercel, vá em **Storage → Create Database → KV**
2. Nomeie como `bolao-kv` e clique em **Create**
3. Clique em **Connect Project** e selecione seu projeto do bolão
4. A Vercel vai adicionar automaticamente as variáveis de ambiente `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` etc.
5. Vá em **Deployments → Redeploy** para o app pegar as variáveis

### 4. Crie sua conta de admin
- Acesse o app no link gerado pela Vercel
- Vá em **Cadastrar** e use o apelido `eduardo` com sua senha
- Sua conta é criada já como admin e aprovada automaticamente

### 5. Compartilhe com os amigos
- Envie o link da Vercel para os amigos
- Eles se cadastram e ficam como **Pendentes**
- Você aprova (ou nega) na aba **Admin** do app

---

## Pontuação
| Acerto | Pontos |
|--------|--------|
| Placar exato (ex: 2x1 = 2x1) | +10 pts |
| Resultado certo (vitória/empate) | +5 pts |
| Gols de um dos times | +2 pts |

---

## Estrutura do projeto
```
bolao-copa-2026/
├── index.html          # Frontend completo
├── vercel.json         # Configuração de rotas
├── package.json        # Dependência: @vercel/kv
└── api/
    ├── auth.js         # Cadastro, login, aprovação
    ├── bolao.js        # Palpites e ranking
    └── games.js        # Proxy dos jogos (com cache no KV)
```

---

## Variáveis de ambiente (adicionadas automaticamente pelo KV)
```
KV_URL
KV_REST_API_URL
KV_REST_API_TOKEN
KV_REST_API_READ_ONLY_TOKEN
```
Não é necessário configurar manualmente se você conectar via painel da Vercel.
