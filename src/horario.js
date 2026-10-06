// Horário comercial: decide quando uma mensagem pode sair.
// Trabalha com instantes em milissegundos (epoch) e um fuso fixo
// (o Brasil não tem horário de verão desde 2019).

const MIN = 60_000;
const DIA = 86_400_000;

export function criarHorario({
  offsetMin = -180, // America/Sao_Paulo = UTC-3
  inicio = '09:00',
  fim = '17:30',
  dias = [1, 2, 3, 4, 5, 6], // 0 = domingo ... 6 = sábado
  feriados = [], // 'AAAA-MM-DD'
} = {}) {
  const paraMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const ini = paraMin(inicio);
  const end = paraMin(fim);
  const fer = new Set(feriados);

  // Dados do dia local que contém o instante t.
  function dia(t) {
    const d = new Date(t + offsetMin * MIN);
    const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offsetMin * MIN;
    return {
      base, // meia-noite local, em epoch
      abre: base + ini * MIN,
      fecha: base + end * MIN,
      util: dias.includes(d.getUTCDay()) && !fer.has(d.toISOString().slice(0, 10)),
    };
  }

  /** O instante t está dentro do horário de envio? */
  function aberto(t) {
    const d = dia(t);
    return d.util && t >= d.abre && t <= d.fecha;
  }

  /** Primeiro instante de envio permitido em t ou depois. */
  function proximo(t) {
    for (let i = 0; i < 30; i++) {
      const d = dia(t);
      if (d.util) {
        if (t <= d.abre) return d.abre;
        if (t <= d.fecha) return t;
      }
      t = d.base + DIA;
    }
    return null;
  }

  /** Último instante de envio permitido em t ou antes. */
  function anterior(t) {
    for (let i = 0; i < 30; i++) {
      const d = dia(t);
      if (d.util) {
        if (t >= d.fecha) return d.fecha;
        if (t >= d.abre) return t;
      }
      t = d.base - 1;
    }
    return null;
  }

  /** Texto local 'DD/MM HH:MM' para notas e painel. */
  function formatar(t) {
    if (t == null) return '-';
    const d = new Date(t + offsetMin * MIN);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  return { aberto, proximo, anterior, formatar };
}
