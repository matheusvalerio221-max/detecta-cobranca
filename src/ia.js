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
- São até 4 cobranças. A partir da 2ª, não repita a anterior: seja mais objetivo, ofereça ajustar escopo ou condição e facilite a resposta (ex.: "posso te ligar?", "prefere que eu agende uma visita?").
- Se o cliente já acusou recebimento ou disse que ia analisar, reconheça isso e pergunte se já teve retorno, sem cobrar de forma pesada.
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

// ---- Leitura da resposta do cliente -------------------------------------
//
// Categorias:
//   aprovou  - fechou / autorizou / pediu agendamento
//   recusou  - não vai fechar, fechou com outro, achou caro e desistiu
//   duvida   - fez uma pergunta ou pediu ajuste (a atendente precisa responder)
//   pensar   - vai analisar, repassar, dar retorno depois
//   recebeu  - só acusou recebimento ou agradeceu, sem decidir nada
//   outro    - não dá para saber (tratado como "a atendente precisa ver")

export const CATEGORIAS = ['aprovou', 'recusou', 'duvida', 'pensar', 'recebeu', 'outro'];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Leitura por palavras-chave: usada sem IA ou quando a IA falha. */
export function classificarPadrao(texto) {
  const t = norm(texto);
  if (!t) return 'outro';
  if (/\b(nao (vamos|vou|iremos|temos interesse|tenho interesse|quero|queremos|vai dar|vai rolar)|sem interesse|fechei com|fechamos com|fechou com|outra empresa|muito caro|desist|cancel|recus|declin|fora do (orcamento|budget)|nao aprovad)\b/.test(t)) return 'recusou';
  if (/\b(aprovad[oa]|aprovo|autoriz|pode (fazer|agendar|vir|seguir|marcar|mandar|enviar o contrato)|vamos fechar|fechad[oa]|fechamos|fechar com voces|aceito|de acordo|confirmo|confirmado|pode marcar|quero fechar|vou fechar|pode agendar|agende|segue aprova)\b/.test(t)) return 'aprovou';
  if (/\?|\b(quanto|qual|quais|como|quando|prazo|desconto|parcel|inclu[io]|garantia|valor|preco|forma de pagamento|boleto|pix|cartao|visita|horario|poderia|consegue|da pra|tem como|pode (reduzir|melhorar|baixar|diminuir))\b/.test(t)) return 'duvida';
  if (/\b(vou (analisar|avaliar|ver|pensar|verificar|passar|encaminhar|repassar|conversar|apresentar|levar|olhar)|analisando|avaliando|aguard|retorno|te aviso|aviso voces|depois|em breve|assim que|semana que vem|proxima semana|diretoria|gerente|socio|chefe|dono|aprovacao interna|cotando|outros orcamentos|comparando)\b/.test(t)) return 'pensar';
  if (/^(ok+|okay|oi|ola|obrigad[oa]s?|recebi|recebido|certo|blz|beleza|valeu|otimo|perfeito|show|ta|ta bom|tudo bem|bom dia|boa tarde|boa noite|joia|legal|entendi|vou ver|ciente|anotado|\p{Emoji})[\s!.,]*(obrigad[oa]s?[\s!.,]*)?$/u.test(t)) return 'recebeu';
  if (t.length <= 20 && !/\d/.test(t)) return 'recebeu';
  return 'outro';
}

const SISTEMA_LEITURA = `Você lê a resposta de um cliente a uma proposta de orçamento da Detecta (controle de pragas) enviada pelo WhatsApp e a classifica em UMA categoria:

aprovou - o cliente fechou, aprovou, autorizou ou pediu para agendar o serviço.
recusou - o cliente disse que não vai fechar, fechou com outra empresa, desistiu ou recusou.
duvida  - o cliente fez uma pergunta, pediu ajuste, desconto, prazo ou qualquer coisa que uma atendente humana precisa responder.
pensar  - o cliente vai analisar, repassar para alguém, comparar ou dar retorno depois. Ainda não decidiu.
recebeu - o cliente só confirmou o recebimento, agradeceu ou cumprimentou, sem decidir nada nem perguntar nada.
outro   - não dá para saber.

Responda somente com a palavra da categoria, em minúsculas, sem explicação.`;

export function criarIA({ chave, modelo = 'claude-sonnet-5-5', agenda = '', timeoutMs = 30_000, log = console }) {
  async function perguntar(system, user, maxTokens) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  /** @returns {Promise<{categoria:string, origem:'ia'|'padrao'}>} */
  async function classificar({ textoCliente, mensagens = [] }) {
    const padrao = { categoria: classificarPadrao(textoCliente), origem: 'padrao' };
    if (!chave) return padrao;
    if (!String(textoCliente || '').trim()) return { categoria: 'outro', origem: 'padrao' }; // só anexo/áudio
    const pedido = ['Conversa até agora (mais antiga primeiro):', transcricao(mensagens.slice(-12)) || '(sem histórico)', '', `Resposta do cliente a classificar: "${String(textoCliente).slice(0, 800)}"`].join('\n');
    try {
      const r = (await perguntar(SISTEMA_LEITURA, pedido, 10)).toLowerCase().replace(/[^a-z]/g, '');
      if (!CATEGORIAS.includes(r)) throw new Error(`categoria inesperada: ${r}`);
      return { categoria: r, origem: 'ia' };
    } catch (e) {
      log.warn(`[ia] leitura da resposta pelo padrão: ${e.message}`);
      return padrao;
    }
  }

  /** @returns {Promise<{texto:string, origem:'ia'|'padrao'}>} */
  async function redigir({ contato, atendente, numero, arquivo, mensagens }) {
    const padrao = { texto: textoPadrao({ contato, numero }), origem: 'padrao' };
    if (!chave) return padrao;
    const pedido = [
      `Contato no WhatsApp: ${contato || '(sem nome)'}`,
      `Atendente responsável: ${atendente || '(não informado)'}`,
      `Arquivo da proposta: ${arquivo || '(não identificado)'}`,
      `Esta é a ${numero}ª cobrança (de no máximo 4).`,
      agenda ? `Disponibilidade de agenda que pode ser mencionada, se fizer sentido: ${agenda}` : '',
      '',
      'Conversa até agora (mais antiga primeiro):',
      transcricao(mensagens) || '(sem histórico disponível)',
    ]
      .filter((l) => l !== '')
      .join('\n');
    try {
      const texto = (await perguntar(SISTEMA, pedido, 400)).replace(/^["“]|["”]$/g, '');
      if (!valido(texto)) throw new Error('texto gerado fora do padrão');
      return { texto, origem: 'ia' };
    } catch (e) {
      log.warn(`[ia] usando texto padrão: ${e.message}`);
      return padrao;
    }
  }
  return { redigir, classificar };
}
