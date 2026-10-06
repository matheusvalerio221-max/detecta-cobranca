// Motor da cobrança: recebe eventos do Bradial, decide quando cobrar e envia.
//
// Modos:
//   sombra - NÃO envia nada ao cliente. Grava a sugestão como mensagem privada
//            na conversa, para a atendente ver e enviar se concordar.
//   auto   - envia a cobrança ao cliente pela API oficial do WhatsApp.

import { planejar, PADRAO } from './regras.js';
import { normalizar } from './normalizar.js';

const MIN = 60_000;
const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function criarMotor({ db, horario, bradial, ia, cfg = {}, agora = () => Date.now(), log = console }) {
  const c = {
    modo: 'sombra',
    regexProposta: /P[A-Z]\d{2}-\d{3}/i, // ex.: PE09-184, PC10-001
    etiquetaProposta: '', // opcional: etiqueta que também dispara a cobrança
    caixasPermitidas: [], // vazio = todas
    somenteTelefones: [], // vazio = todos; preenchido = modo de teste
    carenciaRetomadaMs: 10 * MIN, // mensagens da atendente logo após a proposta não contam como retomada
    historico: 30, // mensagens enviadas à IA como contexto
    reterDias: 90,
    regras: PADRAO,
    ...cfg,
  };
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  const telefonesTeste = c.somenteTelefones.map(digitos).filter(Boolean);

  function conversaPermitida(conv) {
    if (!conv.id) return false;
    if (c.caixasPermitidas.length && !c.caixasPermitidas.includes(conv.inboxId)) return false;
    if (telefonesTeste.length) {
      const tel = digitos(conv.telefone);
      if (!tel || !telefonesTeste.some((t) => tel.endsWith(t) || t.endsWith(tel))) return false;
    }
    return true;
  }

  function gravarConversa(conv, t) {
    const atual = db.get('SELECT * FROM conversas WHERE id = ?', conv.id);
    if (!atual) {
      db.run(
        'INSERT INTO conversas (id, inbox_id, contato, telefone, atendente, status, pode_responder, atualizado_em) VALUES (?,?,?,?,?,?,?,?)',
        conv.id, conv.inboxId || null, conv.contato, conv.telefone, conv.atendente, conv.status,
        conv.podeResponder == null ? null : Number(conv.podeResponder), t,
      );
    } else {
      db.run(
        'UPDATE conversas SET inbox_id = ?, contato = ?, telefone = ?, atendente = ?, status = ?, pode_responder = ?, atualizado_em = ? WHERE id = ?',
        conv.inboxId || atual.inbox_id, conv.contato || atual.contato, conv.telefone || atual.telefone,
        conv.atendente || atual.atendente, conv.status || atual.status,
        conv.podeResponder == null ? atual.pode_responder : Number(conv.podeResponder), t, conv.id,
      );
    }
  }

  const cobrancaAtiva = (conversaId) =>
    db.get("SELECT * FROM cobrancas WHERE conversa_id = ? AND estado = 'ativa' ORDER BY id DESC LIMIT 1", conversaId);

  function encerrar(cob, estado, t) {
    db.run('UPDATE cobrancas SET estado = ?, encerrada_em = ? WHERE id = ?', estado, t, cob.id);
  }

  async function nota(conversaId, texto) {
    try {
      await bradial.notaPrivada({ conversaId, texto });
    } catch (e) {
      log.warn(`[nota] conversa ${conversaId}: ${e.message}`);
    }
  }

  function abrirCobranca(conv, propostaEm, arquivo, autor) {
    const anterior = cobrancaAtiva(conv.id);
    if (anterior) encerrar(anterior, 'substituida', propostaEm);
    const reg = db.get('SELECT * FROM conversas WHERE id = ?', conv.id);
    const plano = planejar({
      propostaEm,
      ultimoClienteEm: reg?.ultimo_cliente_em ?? null,
      horario,
      cfg: c.regras,
    });
    db.run(
      'INSERT INTO cobrancas (conversa_id, proposta_em, proposta_arquivo, atendente, primeira_em, segunda_em, janela_fim) VALUES (?,?,?,?,?,?,?)',
      conv.id, propostaEm, arquivo || null, autor || conv.atendente || null, plano.primeira, plano.segunda, plano.janelaFim,
    );
    log.info(
      `[proposta] conversa ${conv.id} (${conv.contato}) arquivo=${arquivo || '-'} 1ª=${horario.formatar(plano.primeira)} 2ª=${horario.formatar(plano.segunda)} janela=${horario.formatar(plano.janelaFim)}`,
    );
  }

  /** Um envio recente nosso com o mesmo texto? Então a mensagem que chegou é o eco da nossa cobrança. */
  function ehEco(conversaId, texto, t) {
    const alvo = limpar(texto);
    if (!alvo) return false;
    const recentes = db.all('SELECT texto FROM envios WHERE conversa_id = ? AND em >= ? AND ok = 1', conversaId, t - 15 * MIN);
    return recentes.some((e) => {
      const nosso = limpar(e.texto);
      return alvo.includes(nosso) || nosso.includes(alvo);
    });
  }

  async function tratarMensagem(m) {
    const conv = m.conversa;
    if (!conversaPermitida(conv)) return 'ignorada';
    if (m.tipo === 'atividade') return 'ignorada';
    gravarConversa(conv, m.em);

    let tipo;
    if (m.privada) tipo = 'privada';
    else if (m.tipo === 'entrada') tipo = 'cliente';
    else if (m.humano && !ehEco(conv.id, m.texto, m.em)) tipo = 'atendente';
    else if (m.tipo === 'saida' && ehEco(conv.id, m.texto, m.em)) tipo = 'auto';
    else tipo = 'sistema'; // robô de menu, modelos, automações

    if (Number.isFinite(m.id)) {
      db.run(
        'INSERT OR IGNORE INTO mensagens (id, conversa_id, em, tipo, autor, texto, anexos) VALUES (?,?,?,?,?,?,?)',
        m.id, conv.id, m.em, tipo, m.autor, m.texto, m.anexos.join(', ') || null,
      );
    }

    if (tipo === 'cliente') {
      db.run('UPDATE conversas SET ultimo_cliente_em = ?, pode_responder = 1 WHERE id = ?', m.em, conv.id);
      const cob = cobrancaAtiva(conv.id);
      if (cob && m.em >= cob.proposta_em) {
        encerrar(cob, 'respondida', m.em);
        if (cob.primeira_enviada_em || cob.segunda_enviada_em) {
          await nota(conv.id, '🤖 Cobrança automática: o cliente respondeu depois da cobrança da proposta. Favor retomar a negociação.');
        }
        log.info(`[respondida] conversa ${conv.id}`);
      }
      return 'cliente';
    }

    if (tipo === 'atendente') {
      db.run('UPDATE conversas SET ultimo_atendente_em = ? WHERE id = ?', m.em, conv.id);
      const arquivo = m.anexos.find((a) => c.regexProposta.test(a)) || (c.regexProposta.test(m.texto) && m.anexos[0]) || null;
      if (arquivo) {
        abrirCobranca(conv, m.em, arquivo, m.autor);
        return 'proposta';
      }
      const cob = cobrancaAtiva(conv.id);
      if (cob && m.em > cob.proposta_em + c.carenciaRetomadaMs) {
        encerrar(cob, 'retomada', m.em);
        log.info(`[retomada] conversa ${conv.id} por ${m.autor}`);
      }
      return 'atendente';
    }
    return tipo;
  }

  async function tratarConversa(ev) {
    const conv = ev.conversa;
    if (!conversaPermitida(conv)) return 'ignorada';
    const t = agora();
    gravarConversa(conv, t);
    const cob = cobrancaAtiva(conv.id);
    if (cob && conv.status === 'resolved') {
      encerrar(cob, 'encerrada', t);
      return 'encerrada';
    }
    if (!cob && c.etiquetaProposta && conv.etiquetas.includes(c.etiquetaProposta)) {
      // Disparo alternativo por etiqueta, uma vez por conversa a cada 24h.
      const recente = db.get('SELECT id FROM cobrancas WHERE conversa_id = ? AND proposta_em >= ?', conv.id, t - 24 * 60 * MIN);
      if (!recente) {
        abrirCobranca(conv, t, `etiqueta ${c.etiquetaProposta}`, conv.atendente);
        return 'proposta';
      }
    }
    return 'conversa';
  }

  /** Entrada do webhook. Devolve um rótulo do que foi feito (útil em teste e log). */
  async function receberEvento(payload) {
    const ev = normalizar(payload);
    if (!ev) return 'ignorada';
    if (ev.evento === 'mensagem') return tratarMensagem(ev);
    if (ev.evento === 'conversa') return tratarConversa(ev);
    return 'ignorada';
  }

  async function cobrar(cob, numero, t) {
    const conv = db.get('SELECT * FROM conversas WHERE id = ?', cob.conversa_id);
    const coluna = numero === 1 ? 'primeira_enviada_em' : 'segunda_enviada_em';
    // Marca antes de enviar: se algo falhar no meio, não corre o risco de cobrar duas vezes.
    db.run(`UPDATE cobrancas SET ${coluna} = ? WHERE id = ?`, t, cob.id);

    const mensagens = db
      .all("SELECT tipo, autor, texto, anexos FROM mensagens WHERE conversa_id = ? AND tipo IN ('cliente','atendente','auto') ORDER BY em DESC LIMIT ?", cob.conversa_id, c.historico)
      .reverse();
    const { texto, origem } = await ia.redigir({
      contato: conv.contato,
      atendente: cob.atendente,
      numero,
      arquivo: cob.proposta_arquivo,
      mensagens,
    });

    // Registra o envio ANTES de chamar a API: o Bradial devolve a própria mensagem
    // pelo webhook, e ela precisa ser reconhecida como nossa (e não como a
    // atendente retomando a conversa) mesmo que chegue antes da resposta da API.
    const envio = db.run(
      'INSERT INTO envios (cobranca_id, conversa_id, em, numero, modo, origem_texto, texto, ok) VALUES (?,?,?,?,?,?,?,1)',
      cob.id, conv.id, t, numero, c.modo, origem, texto,
    );
    let ok = 1;
    let erro = null;
    try {
      if (c.modo === 'auto') {
        await bradial.enviarTexto({ inboxId: conv.inbox_id, telefone: conv.telefone, texto });
      } else {
        await bradial.notaPrivada({
          conversaId: conv.id,
          texto: `🤖 Sugestão de ${numero}ª cobrança da proposta (NÃO enviada ao cliente — modo de teste):\n\n${texto}`,
        });
      }
    } catch (e) {
      ok = 0;
      erro = e.message;
      db.run('UPDATE envios SET ok = 0, erro = ? WHERE id = ?', erro, envio.lastInsertRowid);
    }
    if (!ok) {
      db.run('UPDATE cobrancas SET ultimo_erro = ? WHERE id = ?', erro, cob.id);
      log.warn(`[falha] conversa ${conv.id} ${numero}ª cobrança: ${erro}`);
      if (c.modo === 'auto') {
        await nota(conv.id, `🤖 Cobrança automática: não consegui enviar a ${numero}ª cobrança ao cliente (${String(erro).slice(0, 120)}). Favor cobrar manualmente.`);
      }
    } else {
      log.info(`[cobrança ${numero}] conversa ${conv.id} (${conv.contato}) modo=${c.modo} texto=${origem}`);
    }
    return ok === 1;
  }

  /** Roda a cada minuto: envia o que venceu e fecha o que expirou. */
  async function tick() {
    const t = agora();
    const ativas = db.all("SELECT * FROM cobrancas WHERE estado = 'ativa'");
    let enviados = 0;
    for (const cob of ativas) {
      const limite = cob.janela_fim != null ? cob.janela_fim - c.regras.margemMs : null;
      const janelaAberta = limite == null || t <= limite;

      const devePrimeira = cob.primeira_em != null && !cob.primeira_enviada_em && t >= cob.primeira_em;
      const deveSegunda =
        cob.segunda_em != null && !cob.segunda_enviada_em && t >= cob.segunda_em &&
        (cob.primeira_enviada_em == null || t >= cob.primeira_enviada_em + c.regras.minEntreMs);

      if ((devePrimeira || deveSegunda) && janelaAberta && horario.aberto(t)) {
        // Se as duas venceram juntas (serviço ficou parado), manda só uma.
        const numero = deveSegunda && (cob.primeira_enviada_em || !devePrimeira) ? 2 : 1;
        if (numero === 1 && deveSegunda) db.run('UPDATE cobrancas SET segunda_em = NULL WHERE id = ?', cob.id);
        await cobrar(cob, numero, t);
        enviados++;
        continue;
      }

      // Encerramento: nada mais a enviar, ou a janela fechou.
      const atual = db.get('SELECT * FROM cobrancas WHERE id = ?', cob.id);
      const pendente =
        (atual.primeira_em != null && !atual.primeira_enviada_em) || (atual.segunda_em != null && !atual.segunda_enviada_em);
      const fimDaLinha = atual.janela_fim != null ? t > atual.janela_fim : !pendente && t > (atual.primeira_enviada_em || atual.proposta_em) + 24 * 60 * MIN;
      if (fimDaLinha || (!pendente && atual.janela_fim == null && atual.primeira_em == null)) {
        encerrar(atual, 'sem_resposta', t);
        if (atual.primeira_enviada_em || atual.segunda_enviada_em) {
          await nota(atual.conversa_id, '🤖 Cobrança automática: proposta cobrada e o cliente não respondeu dentro da janela de 24h. Próximo contato só por modelo de mensagem ou ligação.');
        }
      }
    }
    return enviados;
  }

  function limparAntigos() {
    const corte = agora() - c.reterDias * 24 * 60 * MIN;
    db.run('DELETE FROM mensagens WHERE em < ?', corte);
    db.run('DELETE FROM eventos_brutos WHERE id <= (SELECT COALESCE(MAX(id), 0) - 3000 FROM eventos_brutos)');
  }

  return { receberEvento, tick, limparAntigos, config: c };
}
