// Regra de cobrança de proposta.
//
// 1ª cobrança: 2 horas depois do envio da proposta.
//    Se cair fora do horário de envio, sai na abertura do próximo dia útil.
//    Se a janela de 24h do WhatsApp fechar antes disso, sai no último
//    horário de envio possível antes do fechamento (e vira a única cobrança).
// 2ª cobrança: 30 a 40 minutos antes de fechar a janela de 24h.
//    Se cair fora do horário de envio, sai no último horário válido antes.
//    Só existe se ficar pelo menos 1 hora depois da 1ª.
//
// A janela de 24h conta da última mensagem do CLIENTE, não da proposta.

const MIN = 60_000;
const H = 60 * MIN;

export const PADRAO = {
  esperaMs: 2 * H, // espera até a 1ª cobrança
  antesJanelaMs: 35 * MIN, // antecedência da 2ª cobrança em relação ao fim da janela
  margemMs: 5 * MIN, // folga mínima antes do fim da janela para qualquer envio
  minAposPropostaMs: 30 * MIN, // nunca cobrar antes disso depois da proposta
  minEntreMs: 60 * MIN, // intervalo mínimo entre as duas cobranças
  janelaMs: 24 * H,
};

/**
 * @param {object} p
 * @param {number} p.propostaEm       instante do envio da proposta
 * @param {number|null} p.ultimoClienteEm  última mensagem do cliente (null = desconhecida)
 * @param {object} p.horario          criado por criarHorario()
 * @returns {{primeira:number|null, segunda:number|null, janelaFim:number|null}}
 */
export function planejar({ propostaEm, ultimoClienteEm, horario, cfg = PADRAO }) {
  const janelaFim = ultimoClienteEm != null ? ultimoClienteEm + cfg.janelaMs : null;
  const limite = janelaFim != null ? janelaFim - cfg.margemMs : null;

  let primeira = horario.proximo(propostaEm + cfg.esperaMs);
  let segunda = null;

  if (janelaFim == null) {
    // Sem saber quando o cliente escreveu por último, só a 1ª cobrança é segura.
    return { primeira, segunda: null, janelaFim: null };
  }

  const ultimaChance = horario.anterior(janelaFim - cfg.antesJanelaMs);
  const chanceValida = ultimaChance != null && ultimaChance >= propostaEm + cfg.minAposPropostaMs;

  if (primeira == null || primeira > limite) {
    // A janela fecha antes das 2 horas úteis: uma única cobrança, o mais tarde possível.
    return { primeira: chanceValida ? ultimaChance : null, segunda: null, janelaFim };
  }

  if (chanceValida && ultimaChance >= primeira + cfg.minEntreMs) segunda = ultimaChance;
  return { primeira, segunda, janelaFim };
}
