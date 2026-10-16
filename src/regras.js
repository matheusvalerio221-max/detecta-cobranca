// Regra de cobrança de proposta: até 4 cobranças.
//
// 1ª: 2 horas depois do envio da proposta.
// 2ª: 4 horas depois da 1ª.
// 3ª: na abertura do dia útil seguinte à 2ª.
// 4ª: 30 a 40 minutos antes de fechar a janela de 24h do WhatsApp.
//
// Toda cobrança sai só no horário de envio (seg–sáb, 9h–17h30): o que cair
// fora é empurrado para o próximo horário válido. A janela de 24h conta da
// última mensagem do CLIENTE.
//
// Sem modelo (template) aprovado, só é possível enviar dentro da janela: as
// cobranças que cairiam depois dela são descartadas. Com modelo, elas ficam e
// saem pelo modelo quando a janela já fechou.

const MIN = 60_000;
const H = 60 * MIN;

export const PADRAO = {
  esperaMs: 2 * H, // proposta -> 1ª
  entreMs: 4 * H, // 1ª -> 2ª
  antesJanelaMs: 35 * MIN, // antecedência da última cobrança em relação ao fim da janela
  margemMs: 5 * MIN, // folga mínima antes do fim da janela para qualquer envio
  minAposPropostaMs: 30 * MIN, // nunca cobrar antes disso depois da proposta
  minEntreMs: 60 * MIN, // intervalo mínimo entre duas cobranças
  janelaMs: 24 * H,
  maximo: 4,
};

/** A janela de 24h ainda permite texto livre no instante t? */
export function janelaAberta({ ultimoClienteEm, t, cfg = PADRAO }) {
  if (ultimoClienteEm == null) return false;
  return t <= ultimoClienteEm + cfg.janelaMs - cfg.margemMs;
}

/**
 * Monta os horários das cobranças que ainda faltam.
 *
 * @param {object} p
 * @param {number} p.inicioEm         referência da 1ª cobrança (envio da proposta, ou a última resposta do cliente ao replanejar)
 * @param {number|null} p.ultimoClienteEm  última mensagem do cliente (null = desconhecida)
 * @param {object} p.horario          criado por criarHorario()
 * @param {boolean} [p.comModelo]     há modelo aprovado para cobrar depois da janela?
 * @param {number} [p.quantas]        quantas cobranças ainda cabem (padrão: todas)
 * @param {boolean} [p.adiar]         cliente pediu tempo: a próxima só no dia útil seguinte
 * @returns {{etapas:number[], janelaFim:number|null}}
 */
export function planejar({ inicioEm, propostaEm = inicioEm, ultimoClienteEm, horario, cfg = PADRAO, comModelo = false, quantas = cfg.maximo, adiar = false }) {
  const janelaFim = ultimoClienteEm != null ? ultimoClienteEm + cfg.janelaMs : null;
  const limite = janelaFim != null ? janelaFim - cfg.margemMs : null;
  const cedoDemais = propostaEm + cfg.minAposPropostaMs;

  const e1 = adiar ? horario.proximoDia(inicioEm) : horario.proximo(inicioEm + cfg.esperaMs);
  const e2 = e1 != null ? horario.proximo(e1 + cfg.entreMs) : null;
  const e3 = e2 != null ? horario.proximoDia(e2) : null;
  const e4 = janelaFim != null ? horario.anterior(janelaFim - cfg.antesJanelaMs) : null;

  let etapas = [e1, e2, e3, e4].filter((t) => t != null && t >= cedoDemais);

  if (!comModelo) {
    if (limite == null) etapas = etapas.slice(0, 1); // sem saber a janela, só a 1ª é segura
    else {
      etapas = etapas.filter((t) => t <= limite);
      // A janela fecha antes das 2 horas úteis: uma única cobrança, o mais tarde possível.
      if (e1 != null && e1 > limite && e4 != null && e4 >= cedoDemais) etapas = [e4];
    }
  }

  // Ordena e garante o intervalo mínimo entre cobranças. Quando duas caem
  // juntas, fica a mais tarde (em geral a que aproveita o fim da janela).
  etapas.sort((a, b) => a - b);
  const final = [];
  for (const t of etapas) {
    if (final.length && t < final[final.length - 1] + cfg.minEntreMs) final[final.length - 1] = t;
    else final.push(t);
  }
  // Com modelo, completa até o máximo com um dia útil a mais por cobrança.
  while (comModelo && final.length && final.length < cfg.maximo) {
    const prox = horario.proximoDia(final[final.length - 1]);
    if (prox == null) break;
    final.push(prox);
  }
  return { etapas: final.slice(0, Math.max(0, quantas)), janelaFim };
}
