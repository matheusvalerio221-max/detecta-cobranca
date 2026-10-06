// Redação da mensagem de cobrança.
// Usa a API da Anthropic quando há chave configurada; se não houver, ou se a
// chamada falhar, cai no texto padrão. O serviço nunca deixa de cobrar por
// causa da IA.

const SETORES = /^(compras|financeiro|fiscal|rh|suprimentos|inspetores?|comercial|qualidade|manuten[cç][aã]o|recep[cç][aã]o|adm|administrativo|contato|atendimento|portaria|sac|ti)$/i;

/** Primeiro nome do contato, ou '' quando o contato é um setor/empresa. */
export function primeiroNome(contato) {
  const parte = String(contato || '').split(/\s[-–|]\s/)[0].trim();
  const palavra = parte.split(/\s+/)[0] || '';
  if (!/^[A-Za-zÀ-ÿ]{2,}$/.test(palavra)) return '';
  if (SETORES.test(palavra)) return '';
  if (/[A-ZÀ-Ý]/.test(palavra.slice(1))) return ''; // sigla ou nome de empresa (TRB, BrasPoint, DETECTA)
  return palavra[0].toUpperCase() + palavra.slice(1).toLowerCase();
}

export function textoPadrao({ contato, numero }) {
  const nome = primeiroNome(contato);
  const oi = nome ? `Olá, ${nome}! Tudo bem?` : 'Olá! Tudo bem?';
  if (numero === 1) {
    return `${oi} Aqui é da equipe comercial da Detecta. Conseguiu avaliar a proposta que enviamos? Se ficou alguma dúvida ou se precisar ajustar algum ponto para fecharmos, é só me dizer.`;
  }
  return `${oi} Passando para saber se podemos seguir com a proposta da Detecta. Há algo que possamos ajustar em escopo, prazo ou condição para fecharmos? Fico à disposição.`;
}

const SISTEMA = `Você escreve mensagens curtas de WhatsApp em nome da equipe comercial da Detecta, empresa de controle de pragas da região de Campinas/SP.

Tarefa: escrever UMA mensagem de acompanhamento para um cliente que recebeu uma proposta de orçamento e ainda não respondeu.

Regras:
- Português do Brasil, tom cordial, profissional e direto. No máximo 350 caracteres. No máximo um emoji, e só se combinar com a conversa.
- Cumprimente pelo primeiro nome quando o contato for uma pessoa. Se o contato for um setor ou empresa (ex.: "Compras"), não invente nome.
- Se a conversa deixar claro qual serviço foi orçado, cite-o em poucas palavras.
- Pergunte se conseguiu avaliar a proposta, se ficou alguma dúvida e o que falta para fechar.
- Não invente preço, desconto, prazo, data, condição de pagamento nem promessa que não esteja na conversa.
- Não se apresente como uma atendente específica. Fale como equipe comercial da Detecta.
- Se o cliente já levantou uma dúvida ou objeção na conversa, reconheça-a em vez de ignorá-la.
- Na 2ª cobrança, não repita a 1ª: seja mais objetivo, ofereça ajustar escopo ou condição e facilite a resposta.
- Responda apenas com o texto da mensagem, sem aspas, sem título e sem explicação.`;

function transcricao(mensagens) {
  return mensagens
    .map((m) => {
      const quem = m.tipo === 'cliente' ? 'CLIENTE' : m.tipo === 'auto' ? 'DETECTA (cobrança anterior)' : `DETECTA (${m.autor || 'atendente'})`;
      const anexos = m.anexos ? ` [anexo: ${m.anexos}]` : '';
      return `${quem}: ${(m.texto || '').slice(0, 600)}${anexos}`;
    })
    .join('\n');
}

function valido(texto) {
  if (!texto) return false;
  if (texto.length < 20 || texto.length > 600) return false;
  if (/[\[\]{}<>]/.test(texto)) return false; // sobrou marcador de preenchimento
  return true;
}

export function criarIA({ chave, modelo = 'claude-sonnet-5-5', agenda = '', timeoutMs = 30_000, log = console }) {
  /** @returns {Promise<{texto:string, origem:'ia'|'padrao'}>} */
  async function redigir({ contato, atendente, numero, arquivo, mensagens }) {
    const padrao = { texto: textoPadrao({ contato, numero }), origem: 'padrao' };
    if (!chave) return padrao;
    const pedido = [
      `Contato no WhatsApp: ${contato || '(sem nome)'}`,
      `Atendente responsável: ${atendente || '(não informado)'}`,
      `Arquivo da proposta: ${arquivo || '(não identificado)'}`,
      `Esta é a ${numero}ª cobrança.`,
      agenda ? `Disponibilidade de agenda que pode ser mencionada, se fizer sentido: ${agenda}` : '',
      '',
      'Conversa até agora (mais antiga primeiro):',
      transcricao(mensagens) || '(sem histórico disponível)',
    ]
      .filter((l) => l !== '')
      .join('\n');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelo, max_tokens: 400, system: SISTEMA, messages: [{ role: 'user', content: pedido }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      const texto = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^["“]|["”]$/g, '');
      if (!valido(texto)) throw new Error('texto gerado fora do padrão');
      return { texto, origem: 'ia' };
    } catch (e) {
      log.warn(`[ia] usando texto padrão: ${e.message}`);
      return padrao;
    }
  }
  return { redigir };
}
