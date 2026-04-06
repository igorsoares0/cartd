# Ambientes (dev e prod)

Este app usa dois ambientes:

- **Dev (local)**: roda com Shopify CLI.
- **Prod (Vercel)**: roda publicado.

## 1) Configuração de DEV (local)

### `.env` local (mínimo necessário)

No dev com `shopify app dev`, o Shopify CLI injeta automaticamente variáveis como `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES` e `SHOPIFY_APP_URL`.

Por isso, no `.env` local normalmente basta:

```env
DATABASE_URL=postgresql://...
```

Opcional:

```env
SHOP_CUSTOM_DOMAIN=...
```

### Arquivo Shopify de dev

Use o arquivo `shopify.app.dev.toml`.

Para desenvolvimento:

```bash
npm run dev
```

Esse comando já troca para o config de dev e roda `shopify app dev`.

## 2) Configuração de PROD (Vercel)

### Variáveis na Vercel (produção)

Configure no projeto da Vercel:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL` (URL pública da Vercel)
- `SCOPES`
- `DATABASE_URL` (banco de produção)
- `SHOP_CUSTOM_DOMAIN` (opcional)

`NODE_ENV=production` normalmente já é definido pela Vercel.

### Arquivo Shopify de produção

Use o arquivo `shopify.app.prod.toml` com os dados de produção:

- `client_id` do app Shopify de produção
- `application_url` com domínio real
- `app_proxy.url` com domínio real
- `auth.redirect_urls` com domínio real

Depois sincronize com a Shopify:

```bash
npm run deploy:prod
```

## 3) Deploy em produção (fluxo)

1. `git push` na branch conectada à Vercel (ex.: `main`) publica o código.
2. A Vercel faz build com `npm run vercel-build`.
3. Sempre que mudar `shopify.app.prod.toml`, escopos ou webhooks, rode também:

```bash
npm run deploy:prod
```

## 4) Prisma Migrations

- **No dev**: sempre use `prisma migrate dev` para criar migrations. Nunca use `prisma db push` — ele sincroniza o banco sem gerar arquivo de migration, o que causa dessincronização com o banco de produção.
- **No prod**: o `prisma migrate deploy` roda automaticamente no build da Vercel (configurado no script `build` do `package.json`). Ele aplica apenas migrations que existem como arquivos `.sql` em `prisma/migrations/`.

Fluxo correto:

```bash
# 1. Altere o schema.prisma
# 2. Gere a migration no dev
npx prisma migrate dev --name nome_da_migration
# 3. git push → Vercel aplica automaticamente no banco de prod
```

## 5) Troca manual de config Shopify

```bash
npm run shopify:config:dev
npm run shopify:config:prod
```
