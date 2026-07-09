# Assistente WhatsApp Play Zone — Guia de Instalação

Bot de WhatsApp com IA que recebe mensagens, responde ao nível expert, consulta **preços e stock reais** do WooCommerce (nunca inventa), regista encomendas e alerta a equipa. Escala para humano quando preciso.

```
Cliente no WhatsApp
      │
      ▼
Meta Cloud API ──(webhook)──►  ESTE SERVIDOR (Node)
                                   │  ├─ IA Claude (decide o que responder)
                                   │  ├─ WooCommerce (preço/stock reais + cria encomenda)
                                   │  ├─ Pesquisa IA do site (sugere categorias por necessidade)
                                   │  └─ Alerta à equipa / handoff humano
                                   ▼
                          Resposta enviada ao cliente
```

**Cérebro partilhado com o site (2026-07):** quando o cliente descreve uma *necessidade*
("shampoo para cabelo seco", "quero ganhar massa") em vez de um produto, o bot chama a
ferramenta `sugerir_categorias`, que consulta o mesmo endpoint da Pesquisa IA do site
(`playzone.ao/wp-admin/admin-ajax.php`, action `pz_ai_search`). Vantagens: uma única
fonte de verdade, links de categorias sempre reais, e as perguntas do WhatsApp entram
nas analytics em **wp-admin → Opções → Pesquisa IA**. Fail-closed: se o site não
responder, o bot continua a conversa sem links. Variável opcional: `SITE_BASE_URL`
(por omissão usa o domínio do `WOO_BASE_URL`). Para preços concretos o bot continua a
usar `procurar_produto` (WooCommerce direto).

---

## O que só TU (Victor) tens de fazer
Estas ações envolvem contas, tokens e pagamentos — o assistente **nunca** as faz por ti.

### 1. WhatsApp Cloud API (Meta)
1. Em https://developers.facebook.com/ → a tua App → **WhatsApp**.
2. Copia o **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. Cria um **System User** com token permanente (Business Settings → Users → System Users) com permissão `whatsapp_business_messaging` → `WHATSAPP_TOKEN`.
4. Em **App Settings → Basic**, copia o **App Secret** → `WHATSAPP_APP_SECRET`.
5. Inventa uma frase secreta (ex.: `playzone-2026-xyz`) → põe em `WHATSAPP_VERIFY_TOKEN` **e** no campo "Verify token" do webhook (passo 6 abaixo).

### 2. Chave de IA (Anthropic Claude)
- https://console.anthropic.com/ → API Keys → cria uma chave → `ANTHROPIC_API_KEY`.

### 3. Chaves WooCommerce (playzone.ao)
- WordPress → WooCommerce → **Definições → Avançado → REST API → Adicionar chave**.
- Permissões: **Leitura/Escrita** (precisa de escrever para criar encomendas).
- Copia `Consumer key` → `WOO_CONSUMER_KEY` e `Consumer secret` → `WOO_CONSUMER_SECRET`.

> ⚠️ Nunca me envies estes valores a mim. Colocas tu no ficheiro `.env`, no teu servidor.

---

## Instalação
```bash
# 1. Requisitos: Node.js 20 ou superior
node --version

# 2. Instalar dependências
npm install

# 3. Configurar o ambiente
cp .env.example .env
#    -> abre .env e preenche TODOS os valores dos passos 1–3 acima

# 4. Arrancar
npm start
# Deves ver: {"event":"server.started","port":8080,...}
```

Testa localmente: `curl http://localhost:8080/health` → `{"ok":true,...}`

---

## Correr com Docker (recomendado para produção)
```bash
cp .env.example .env      # preenche os teus valores
docker compose up -d --build
docker compose logs -f    # ver arranque e mensagens
```
A imagem corre como utilizador não-root e tem healthcheck (`/health`) — o Docker reinicia sozinho se falhar.

## Deploy na cloud (1-click)
- **Render:** existe `render.yaml`. New → Blueprint → aponta ao repositório → preenche os secretos (WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, ANTHROPIC_API_KEY, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET). Dá-te um URL HTTPS.
- **Railway:** existe `railway.json`. New Project → Deploy from repo (usa o Dockerfile) → adiciona as mesmas variáveis. Gera domínio HTTPS.
- **VPS teu:** `docker compose up -d --build` atrás de um proxy HTTPS (Caddy/Nginx).

O URL HTTPS que qualquer destes te dá é o que pões no webhook da Meta (secção seguinte), com `/webhook` no fim.

## Testar automaticamente (sem credenciais reais)
```bash
npm test
```
Sobe serviços simulados (WhatsApp + Claude + WooCommerce) e prova o fluxo completo:
recebe "quero um Samsung S23" → consulta o preço real → responde → confirma → **cria a encomenda** → devolve o nº; e verifica que um webhook com **assinatura inválida é rejeitado**. Tudo verde = pronto.

---

## Publicar o webhook (para a Meta chegar ao teu servidor)
O servidor tem de estar acessível por HTTPS público.

- **Teste rápido:** instala `ngrok` e corre `ngrok http 8080`. Usa o URL `https://....ngrok-free.app`.
- **Produção:** aloja num VPS/serviço (Railway, Render, Fly.io, ou um servidor teu) com HTTPS.

Depois, na App Meta → WhatsApp → **Configuration → Webhook**:
1. **Callback URL:** `https://O-TEU-DOMINIO/webhook`
2. **Verify token:** o mesmo que puseste em `WHATSAPP_VERIFY_TOKEN`.
3. Clica **Verify and Save** (o servidor responde ao desafio automaticamente).
4. Em **Webhook fields**, subscreve **`messages`**.

---

## Como testar de ponta a ponta
1. Envia uma mensagem WhatsApp para o número da Play Zone (ex.: "Olá, quero um Samsung S23").
2. O bot procura o produto real, mostra preço/stock e link.
3. Confirma modelo/quantidade e pede nome + telefone + morada.
4. Ao confirmares, cria a encomenda e envia o **nº** + **link de pagamento**.
5. A equipa (números em `TEAM_ALERT_NUMBERS`) recebe um alerta.

---

## Segurança e garantias de qualidade (já implementadas)
- **Nunca inventa preços/stock** — vêm sempre do WooCommerce; se desconhecido, diz que confirma.
- **Fail closed**: se faltar configuração, o servidor não arranca (evita erros silenciosos).
- **Assinatura validada**: só aceita webhooks assinados pela Meta (`X-Hub-Signature-256`).
- **Logging estruturado** (JSON por linha) com telefones mascarados — pronto para auditoria.
- **Handoff humano**: reclamações, garantias, descontos e pedidos do cliente vão para a equipa; enquanto em handoff, o bot não interfere.
- Confirmação explícita antes de criar qualquer encomenda.

## Personalização
- **Respostas / tom / regras:** `prompt/system-prompt.md`
- **Factos (entregas, pagamentos, garantia, loja):** `knowledge/playzone-kb.md`
- **Modelo de IA / limites:** `.env` (`AI_MODEL`, `AI_MAX_TOKENS`)

## Estrutura
```
server.js              Webhook + orquestração
src/config.js          Configuração (fail closed)
src/whatsapp.js        Cliente Cloud API (enviar/receber)
src/woocommerce.js     Preços/stock reais + criar encomenda
src/ai.js              Cérebro IA (Claude + tool-use)
src/session.js         Memória de conversa por cliente
src/logger.js          Logging estruturado
knowledge/             Base de conhecimento (factual)
prompt/                Persona e regras do assistente
```

## Limitações atuais (evoluções possíveis)
- Sessões em memória (reinício apaga contexto) → trocar por Redis/DB para produção a sério.
- Trata texto e botões; imagem/áudio → encaminha para humano.
- Uma resposta por mensagem; sem envio proativo/campanhas (pode ser adicionado).
