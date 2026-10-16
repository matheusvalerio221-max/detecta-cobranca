# Detecta Cobrança

Acompanhamento automático das propostas enviadas pelo Bradial Chat.

## O que faz

1. Recebe do Bradial, por webhook, cada mensagem criada nas conversas.
2. Quando uma atendente envia o PDF da proposta (nome como `PE09-184` ou `PC10-001`), abre uma cobrança.
3. Até 4 cobranças, se o cliente não decidir:
   - 1ª: 2 horas depois da proposta;
   - 2ª: 4 horas depois da 1ª;
   - 3ª: na abertura do dia útil seguinte;
   - 4ª: 30 a 40 minutos antes de fechar a janela de 24h do WhatsApp.
4. Só envia de segunda a sábado, das 9h às 17h30. Fora disso, sai no próximo horário válido.
5. Dentro da janela de 24h a cobrança é texto livre (escrito pela IA com o contexto da conversa, ou texto padrão).
   Depois da janela, só sai se houver um **modelo aprovado pela Meta** configurado (campo "Modelo aprovado" em Configuração).
6. Lê a resposta do cliente (IA, com reserva por palavras-chave):
   - **aprovou** → encerra e avisa a atendente para agendar;
   - **recusou** → encerra e avisa;
   - **perguntou / pediu ajuste** → encerra: a atendente precisa responder;
   - **vai analisar** → continua, mas a próxima cobrança só no dia útil seguinte;
   - **só confirmou recebimento** ("ok", "obrigado") → continua cobrando, contagem recomeça.
7. Mensagem da atendente logo depois da proposta ("fico à disposição") não cancela nada. Só cancela quando ela responde a uma mensagem do cliente.
8. Para também quando a conversa é finalizada no Bradial. Avisa a atendente por mensagem privada na conversa.

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
