// Converte o payload do webhook do Bradial em um formato único e previsível.
// O Bradial segue o formato de eventos documentado em docs.bradial.com.br
// (message_created, conversation_status_changed, ...). Alguns campos podem vir
// como número ou como texto dependendo da versão, então aceitamos os dois.

function instante(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function tipoMensagem(v) {
  const s = String(v).toLowerCase();
  if (s === '0' || s === 'incoming') return 'entrada';
  if (s === '1' || s === 'outgoing') return 'saida';
  if (s === '3' || s === 'template') return 'modelo';
  return 'atividade';
}

function nomeArquivo(a) {
  const direto = a.file_name || a.filename || a.name || a.fallback_title || a.title;
  if (direto) return String(direto);
  const url = a.data_url || a.file_url || a.url || '';
  try {
    const ultimo = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(ultimo);
  } catch {
    return '';
  }
}

export function normalizar(p) {
  if (!p || typeof p !== 'object') return null;
  const evento = p.event;

  if (evento === 'message_created') {
    const conv = p.conversation || {};
    const remetente = p.sender || {};
    const contato = conv.meta?.sender || (remetente.type === 'contact' ? remetente : {});
    const tipo = tipoMensagem(p.message_type);
    const privada = p.private === true || p.private === 'true';
    return {
      evento: 'mensagem',
      id: Number(p.id),
      em: instante(p.created_at) ?? Date.now(),
      texto: p.content || '',
      tipo, // entrada | saida | modelo | atividade
      privada,
      humano: tipo === 'saida' && !privada && String(remetente.type || '').toLowerCase() === 'user',
      autor: remetente.name || '',
      anexos: (p.attachments || []).map(nomeArquivo).filter(Boolean),
      conversa: {
        id: Number(conv.id ?? conv.display_id),
        inboxId: Number(conv.inbox_id ?? p.inbox?.id),
        status: conv.status || null,
        podeResponder: conv.can_reply == null ? null : conv.can_reply === true || conv.can_reply === 'true',
        contato: contato.name || '',
        telefone: contato.phone_number || conv.contact_inbox?.source_id || '',
        atendente: conv.meta?.assignee?.name || '',
        etiquetas: (conv.labels || []).map((l) => (typeof l === 'string' ? l : l.title)).filter(Boolean),
      },
    };
  }

  if (evento === 'conversation_status_changed' || evento === 'conversation_updated') {
    return {
      evento: 'conversa',
      conversa: {
        id: Number(p.id ?? p.display_id),
        inboxId: Number(p.inbox_id),
        status: p.status || null,
        podeResponder: p.can_reply == null ? null : p.can_reply === true || p.can_reply === 'true',
        contato: p.meta?.sender?.name || '',
        telefone: p.meta?.sender?.phone_number || p.contact_inbox?.source_id || '',
        atendente: p.meta?.assignee?.name || '',
        etiquetas: (p.labels || []).map((l) => (typeof l === 'string' ? l : l.title)).filter(Boolean),
      },
    };
  }

  return null;
}
