# Detecta Cobrança

Acompanhamento automático das propostas enviadas pelo Bradial Chat.

## O que faz

1. Recebe do Bradial, por webhook, cada mensagem criada nas conversas.
2. Quando uma atendente envia o PDF da proposta (nome como `PE09-184` ou `PC10-001`), abre uma cobrança.
3. 1ª cobrança: 2 horas depois, se o cliente não respondeu.
4. 2ª cobrança: 30 a 40 minutos antes de fechar a janela de 24h do WhatsApp.
5. Só envia de segunda a sábado, das 9h às 17h30. Fora disso, sai no próximo horário válido (ou no último antes de a janela fechar).
6. Para quando o cliente responde, quando a atendente retoma a conversa ou quando a conversa é finalizada.
7. Avisa a atendente por mensagem privada na conversa.

## Modos

- **Teste (padrão):** não envia nada ao cliente. Grava a sugestão como mensagem privada na conversa.
- **Automático:** envia a cobrança ao cliente pela API oficial do WhatsApp.

A troca é feita em `/cobranca/configurar`.

## Endereços

- `/cobranca/painel` — acompanhamento (usuário `detecta`, senha em `/opt/detecta-cobranca/.env`)
- `/cobranca/configurar` — chaves, modo, horários e dados do webhook
- `/cobranca/saude` — verificação

## Instalação

Fica em `/opt/detecta-cobranca`, na mesma VPS do Detecta Rede, atrás do mesmo Caddy.

```bash
cd /opt/detecta-cobranca
docker compose up -d --build
```

O arquivo `.env` precisa de `WEBHOOK_SECRET` (16+ caracteres) e `PAINEL_SENHA` (8+ caracteres).

## Testes

```bash
node --no-warnings --test test/*.test.js
```

Node 22, sem dependências externas. Banco SQLite em `data/cobranca.sqlite`.
