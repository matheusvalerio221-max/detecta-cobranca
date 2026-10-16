// Cliente da API de Parceiros do Bradial Chat (https://docs.bradial.com.br).
// Autenticação: header x-api-key (chave em Configurações da conta).

export function criarBradial({ base = 'https://api.bradial.com.br', chave, timeoutMs = 20_000 }) {
  async function chamar(metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'x-api-key': chave, 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await r.text();
    if (!r.ok) {
      const e = new Error(`Bradial ${metodo} ${caminho} -> HTTP ${r.status}: ${texto.slice(0, 300)}`);
      e.status = r.status;
      throw e;
    }
    try {
      return texto ? JSON.parse(texto) : null;
    } catch {
      return texto;
    }
  }

  return {
    /**
     * Envia texto livre ao cliente pela API oficial do WhatsApp.
     * Só funciona dentro da janela de 24h. A mensagem aparece na conversa do Bradial.
     */
    async enviarTexto({ inboxId, telefone, texto }) {
      const digitos = String(telefone || '').replace(/\D/g, '');
      const caminho = `/v2/meta-api/inboxes/${inboxId}/whatsapp/messages`;
      const corpo = (phone) => ({ phone, type: 'text', text: { content: texto } });
      try {
        return await chamar('POST', caminho, corpo(digitos));
      } catch (e) {
        // Algumas contas esperam o número com "+". Tenta uma vez no outro formato.
        if (e.status === 400 || e.status === 404 || e.status === 422) {
          return await chamar('POST', caminho, corpo('+' + digitos));
        }
        throw e;
      }
    },

    /**
     * Envia um modelo (template) aprovado pela Meta. Funciona fora da janela de 24h.
     * `parametros` são os valores das variáveis do corpo, na ordem ({{1}}, {{2}}, ...).
     */
    async enviarModelo({ inboxId, telefone, modelo, parametros = [] }) {
      const digitos = String(telefone || '').replace(/\D/g, '');
      const caminho = `/v2/meta-api/inboxes/${inboxId}/whatsapp/messages/template`;
      const body = Object.fromEntries(parametros.map((v, i) => [String(i + 1), String(v)]));
      const corpo = (phone) => (parametros.length ? { phone, template: modelo, params: { body } } : { phone, template: modelo });
      try {
        return await chamar('POST', caminho, corpo(digitos));
      } catch (e) {
        if (e.status === 400 || e.status === 404 || e.status === 422) {
          return await chamar('POST', caminho, corpo('+' + digitos));
        }
        throw e;
      }
    },

    /** Dados de um modelo (status de aprovação, texto do corpo). */
    async modelo({ inboxId, nome }) {
      return chamar('GET', `/v2/meta-api/inboxes/${inboxId}/whatsapp/templates/${encodeURIComponent(nome)}`);
    },

    /** Grava uma mensagem privada (visível só para a equipe) na conversa. */
    async notaPrivada({ conversaId, texto }) {
      return chamar('POST', `/v2/public-api/v1/conversations/${conversaId}/messages/private`, { content: texto });
    },

    /** Lista as caixas de entrada: usado no teste de conexão. */
    async caixas() {
      return chamar('GET', '/v2/public-api/v1/inboxes?page=1');
    },
  };
}
