// Motor da cobrança: recebe eventos do Bradial, decide quando cobrar e envia.
//
// Modos:
//   sombra - NÃO envia nada ao cliente. Grava a sugestão como mensagem privada
//            na conversa, para a atendente ver e enviar se concordar.
//   auto   - envia a cobrança ao cliente pela API oficial do WhatsApp.
//
// Canais de envio:
//   texto  - texto livre (escrito pela IA ou padrão), só dentro da janela de 24h
//   modelo - modelo aprovado pela Meta, usado quando a janela já fechou

import { planejar, janelaAberta, PADRAO } from './regras.js';
import { normalizar } from './normalizar.js';
import { primeiroNome } from './ia.js';

const MIN = 60_000;
const H = 60 * MIN;
const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export const MODELO_PADRAO = {
  nome: '',
  corpo: 'Olá, {{1}}! Aqui é da equipe comercial da Detecta. Enviamos a proposta {{2}} e gostaríamos de saber se conseguiu avaliá-la. Ficou alguma dúvida ou há algo que possamos ajustar para fecharmos? Fico à disposição.',
};

export function criarMotor({ db, horario, bradial, ia, cfg = {}, agora = () => Date.now(), log = console }) {
  const c = {
    modo: 'sombra',
    regexProposta: /P[A-Z]\d{2}-\d{3}/i, // ex.: PE09-184, PC10-001
    etiquetaProposta: '', // opcional: etiqueta que também dispara a cobrança
    caixasPermitidas: [], // vazio = todas
    somenteTelefones: [], // vazio = todos; preenchido = modo de teste
    modelo: MODELO_PADRAO, // { nome, corpo } — nome vazio = sem modelo (só dentro da janela)
    historico: 30, // mensagens enviadas à IA como contexto
    reterDias: 90,
    regras: PADRAO,
    ...cfg,
  };
  const comModelo = () => Boolean(c.modelo && c.modelo.nome);
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  const telefonesTeste = c.somenteTelefones.map(digitos).filter(Boolean);
  const plano = (cob) => {
    try {
      return JSON.parse(cob.plano || '[]');
    } catch {
      return [];
    }
  };

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

  const descrever = (etapas) => etapas.map((t) => horario.formatar(t)).join(', ') || 'nenhuma';

  function abrirCobranca(conv, propostaEm, arquivo, autor) {
    const anterior = cobrancaAtiva(conv.id);
    if (anterior) encerrar(anterior, 'substituida', propostaEm);
    const reg = db.get('SELECT * FROM conversas WHERE id = ?', conv.id);
    const p = planejar({ inicioEm: propostaEm, ultimoClienteEm: reg?.ultimo_cliente_em ?? null, horario, cfg: c.regras, comModelo: comModelo() });
    db.run(
      'INSERT INTO cobrancas (conversa_id, proposta_em, proposta_arquivo, atendente, primeira_em, segunda_em, janela_fim, plano, etapa) VALUES (?,?,?,?,?,?,?,?,0)',
      conv.id, propostaEm, arquivo || null, autor || conv.atendente || null, p.etapas[0] ?? null, p.etapas[1] ?? null, p.janelaFim, JSON.stringify(p.etapas),
    );
    log.info(`[proposta] conversa ${conv.id} (${conv.contato}) arquivo=${arquivo || '-'} cobranças=${descrever(p.etapas)} janela=${horario.formatar(p.janelaFim)}`);
  }

  /** Cliente escreveu sem decidir: refaz os horários que faltam a partir de agora. */
  function replanejar(cob, clienteEm, adiar) {
    const faltam = c.regras.maximo - cob.etapa;
    const p = planejar({
      inicioEm: clienteEm,
      propostaEm: cob.proposta_em,
      ultimoClienteEm: clienteEm,
      horario,
      cfg: c.regras,
      comModelo: comModelo(),
      quantas: faltam,
      adiar,
    });
    // Nunca cobrar de novo em menos de 1h da última cobrança.
    const etapas = p.etapas.filter((t) => !cob.ultima_enviada_em || t >= cob.ultima_enviada_em + c.regras.minEntreMs);
    db.run('UPDATE cobrancas SET plano = ?, janela_fim = ? WHERE id = ?', JSON.stringify(etapas), p.janelaFim, cob.id);
    log.info(`[replanejada] conversa ${cob.conversa_id} ${adiar ? '(cliente pediu tempo)' : '(cliente só acusou recebimento)'} cobranças=${descrever(etapas)}`);
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

  function historico(conversaId) {
    return db
      .all("SELECT tipo, autor, texto, anexos FROM mensagens WHERE conversa_id = ? AND tipo IN ('cliente','atendente','auto') ORDER BY em DESC LIMIT ?", conversaId, c.historico)
      .reverse();
  }

  async function clienteRespondeu(conv, cob, m) {
    const { categoria, origem } = await ia.classificar({ textoCliente: m.texto, mensagens: historico(conv.id) });
    db.run('UPDATE cobrancas SET classificacao = ? WHERE id = ?', categoria, cob.id);
    const cobrado = cob.etapa > 0;
    log.info(`[cliente] conversa ${conv.id} leitura=${categoria} (${origem}) cobranças feitas=${cob.etapa}`);

    if (categoria === 'aprovou') {
      encerrar(cob, 'aprovada', m.em);
      await nota(conv.id, '🤖 Cobrança automática: o cliente APROVOU a proposta. Favor confirmar e agendar o serviço.');
      return;
    }
    if (categoria === 'recusou') {
      encerrar(cob, 'recusada', m.em);
      await nota(conv.id, '🤖 Cobrança automática: o cliente indicou que NÃO vai seguir com a proposta. Favor verificar se cabe uma contraproposta.');
      return;
    }
    if (categoria === 'recebeu' || categoria === 'pensar') {
      replanejar(cob, m.em, categoria === 'pensar');
      return;
    }
    // duvida | outro: alguém precisa responder; a cobrança automática para aqui.
    encerrar(cob, 'respondida', m.em);
    if (cobrado) {
      await nota(conv.id, '🤖 Cobrança automática: o cliente respondeu depois da cobrança da proposta. Favor retomar a negociação.');
    }
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
    else if ((m.tipo === 'saida' || m.tipo === 'modelo') && ehEco(conv.id, m.texto, m.em)) tipo = 'auto';
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
      if (cob && m.em >= cob.proposta_em) await clienteRespondeu(conv, cob, m);
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
      if (cob) {
        // Só conta como retomada se a atendente está respondendo ao cliente:
        // o cliente escreveu depois da proposta e ela escreveu depois dele.
        // "Fico à disposição" logo após a proposta não cancela nada.
        const clienteDepois = db.get(
          "SELECT MAX(em) em FROM mensagens WHERE conversa_id = ? AND tipo = 'cliente' AND em >= ? AND em < ?",
          conv.id, cob.proposta_em, m.em,
        );
        if (clienteDepois?.em != null) {
          encerrar(cob, 'retomada', m.em);
          log.info(`[retomada] conversa ${conv.id} por ${m.autor}`);
        }
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
      const recente = db.get('SELECT id FROM cobrancas WHERE conversa_id = ? AND proposta_em >= ?', conv.id, t - 24 * H);
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

  const codigoProposta = (arquivo) => {
    const m = String(arquivo || '').match(c.regexProposta);
    return m ? m[0].toUpperCase() : 'de orçamento';
  };

  function textoModelo(conv, cob) {
    const nome = primeiroNome(conv.contato) || 'tudo bem';
    const parametros = [nome, codigoProposta(cob.proposta_arquivo)];
    const texto = String(c.modelo.corpo || MODELO_PADRAO.corpo).replace(/\{\{(\d+)\}\}/g, (_, i) => parametros[Number(i) - 1] ?? '');
    return { texto, parametros };
  }

  async function cobrar(cob, numero, t, canal) {
    const conv = db.get('SELECT * FROM conversas WHERE id = ?', cob.conversa_id);
    // Marca antes de enviar: se algo falhar no meio, não corre o risco de cobrar duas vezes.
    const coluna = numero === 1 ? 'primeira_enviada_em' : numero === 2 ? 'segunda_enviada_em' : null;
    db.run(`UPDATE cobrancas SET etapa = ?, ultima_enviada_em = ?${coluna ? `, ${coluna} = ?` : ''} WHERE id = ?`, ...(coluna ? [numero, t, t, cob.id] : [numero, t, cob.id]));

    let texto;
    let origem;
    let parametros = [];
    if (canal === 'modelo') {
      ({ texto, parametros } = textoModelo(conv, cob));
      origem = 'modelo';
    } else {
      ({ texto, origem } = await ia.redigir({ contato: conv.contato, atendente: cob.atendente, numero, arquivo: cob.proposta_arquivo, mensagens: historico(cob.conversa_id) }));
    }

    // Registra o envio ANTES de chamar a API: o Bradial devolve a própria mensagem
    // pelo webhook, e ela precisa ser reconhecida como nossa (e não como a
    // atendente retomando a conversa) mesmo que chegue antes da resposta da API.
    const envio = db.run(
      'INSERT INTO envios (cobranca_id, conversa_id, em, numero, modo, origem_texto, texto, ok, canal) VALUES (?,?,?,?,?,?,?,1,?)',
      cob.id, conv.id, t, numero, c.modo, origem, texto, canal,
    );
    let ok = 1;
    let erro = null;
    try {
      if (c.modo === 'auto') {
        if (canal === 'modelo') await bradial.enviarModelo({ inboxId: conv.inbox_id, telefone: conv.telefone, modelo: c.modelo.nome, parametros });
        else await bradial.enviarTexto({ inboxId: conv.inbox_id, telefone: conv.telefone, texto });
      } else {
        await bradial.notaPrivada({
          conversaId: conv.id,
          texto: `🤖 Sugestão de ${numero}ª cobrança da proposta${canal === 'modelo' ? ' (pelo modelo aprovado, janela de 24h fechada)' : ''} (NÃO enviada ao cliente — modo de teste):\n\n${texto}`,
        });
      }
    } catch (e) {
      ok = 0;
      erro = e.message;
      db.run('UPDATE envios SET ok = 0, erro = ? WHERE id = ?', erro, envio.lastInsertRowid);
    }
    if (!ok) {
      db.run('UPDATE cobrancas SET ultimo_erro = ? WHERE id = ?', erro, cob.id);
      log.warn(`[falha] conversa ${conv.id} ${numero}ª cobrança (${canal}): ${erro}`);
      if (c.modo === 'auto') {
        await nota(conv.id, `🤖 Cobrança automática: não consegui enviar a ${numero}ª cobrança ao cliente (${String(erro).slice(0, 120)}). Favor cobrar manualmente.`);
      }
    } else {
      log.info(`[cobrança ${numero}] conversa ${conv.id} (${conv.contato}) modo=${c.modo} canal=${canal} texto=${origem}`);
    }
    return ok === 1;
  }

  /** Roda a cada minuto: envia o que venceu e fecha o que expirou. */
  async function tick() {
    const t = agora();
    const ativas = db.all("SELECT * FROM cobrancas WHERE estado = 'ativa'");
    let enviados = 0;
    for (const cob of ativas) {
      const conv = db.get('SELECT * FROM conversas WHERE id = ?', cob.conversa_id);
      const etapas = plano(cob);
      const vencidas = etapas.filter((e) => e <= t);
      // Janela: pela última mensagem do cliente que vimos; se nunca vimos nenhuma,
      // vale o can_reply que o Bradial informa na conversa.
      const ultimoCliente = conv?.ultimo_cliente_em ?? null;
      const aberta = conv?.pode_responder !== 0 && (ultimoCliente == null ? conv?.pode_responder === 1 : janelaAberta({ ultimoClienteEm: ultimoCliente, t, cfg: c.regras }));

      if (vencidas.length && horario.aberto(t) && (!cob.ultima_enviada_em || t >= cob.ultima_enviada_em + c.regras.minEntreMs)) {
        const canal = aberta ? 'texto' : comModelo() ? 'modelo' : null;
        // Se várias venceram juntas (serviço parado), manda só uma e descarta as outras.
        const restantes = etapas.filter((e) => e > t);
        db.run('UPDATE cobrancas SET plano = ? WHERE id = ?', JSON.stringify(restantes), cob.id);
        if (canal) {
          await cobrar(cob, cob.etapa + 1, t, canal);
          enviados++;
          continue;
        }
        log.info(`[pulada] conversa ${cob.conversa_id}: janela fechada e sem modelo aprovado`);
      }

      // Encerramento: nada mais a enviar e a janela (ou um dia desde a última cobrança) passou.
      const atual = db.get('SELECT * FROM cobrancas WHERE id = ?', cob.id);
      const pendentes = plano(atual);
      const umDia = (atual.ultima_enviada_em ?? atual.proposta_em) + 24 * H;
      // Com modelo, espera o cliente até um dia depois da última cobrança; sem modelo, até a janela fechar.
      const esperaFim = comModelo() ? Math.max(atual.janela_fim ?? 0, umDia) : (atual.janela_fim ?? umDia);
      const semSaida = pendentes.length === 0 || (!aberta && !comModelo());
      if (semSaida && t > esperaFim) {
        encerrar(atual, 'sem_resposta', t);
        if (atual.etapa > 0) {
          await nota(
            atual.conversa_id,
            `🤖 Cobrança automática: proposta cobrada ${atual.etapa}x e o cliente não respondeu. Encerrando o acompanhamento automático; próximo contato por ligação ou mensagem da atendente.`,
          );
        }
      }
    }
    return enviados;
  }

  function limparAntigos() {
    const corte = agora() - c.reterDias * 24 * H;
    db.run('DELETE FROM mensagens WHERE em < ?', corte);
    db.run('DELETE FROM eventos_brutos WHERE id <= (SELECT COALESCE(MAX(id), 0) - 3000 FROM eventos_brutos)');
  }

  return { receberEvento, tick, limparAntigos, config: c };
}
