import test from 'node:test';
import assert from 'node:assert/strict';
import { criarHorario } from '../src/horario.js';
import { planejar } from '../src/regras.js';

import { sp } from './util.js';

const h = criarHorario();
const f = (t) => (t == null ? null : h.formatar(t));

test('horário: aberto de segunda a sábado, 9h às 17h30', () => {
  assert.equal(h.aberto(sp('2026-10-05 09:00')), true);
  assert.equal(h.aberto(sp('2026-10-05 17:30')), true);
  assert.equal(h.aberto(sp('2026-10-05 08:59')), false);
  assert.equal(h.aberto(sp('2026-10-05 17:31')), false);
  assert.equal(h.aberto(sp('2026-10-10 10:00')), true, 'sábado');
  assert.equal(h.aberto(sp('2026-10-11 10:00')), false, 'domingo');
});

test('horário: próximo e anterior', () => {
  assert.equal(f(h.proximo(sp('2026-10-05 19:00'))), '06/10 09:00');
  assert.equal(f(h.proximo(sp('2026-10-05 07:00'))), '05/10 09:00');
  assert.equal(f(h.proximo(sp('2026-10-05 11:20'))), '05/10 11:20');
  assert.equal(f(h.proximo(sp('2026-10-10 18:00'))), '12/10 09:00', 'sábado à noite vai para segunda');
  assert.equal(f(h.anterior(sp('2026-10-06 07:25'))), '05/10 17:30');
  assert.equal(f(h.anterior(sp('2026-10-11 15:00'))), '10/10 17:30', 'domingo volta para sábado');
  assert.equal(f(h.anterior(sp('2026-10-05 12:00'))), '05/10 12:00');
});

test('horário: feriado é pulado', () => {
  const hf = criarHorario({ feriados: ['2026-10-12'] });
  assert.equal(hf.formatar(hf.proximo(sp('2026-10-10 18:00'))), '13/10 09:00');
});

test('caso comum: proposta de manhã, 1ª em 2h e 2ª antes de fechar a janela', () => {
  const p = planejar({ propostaEm: sp('2026-10-05 10:00'), ultimoClienteEm: sp('2026-10-05 09:50'), horario: h });
  assert.equal(f(p.primeira), '05/10 12:00');
  assert.equal(f(p.segunda), '06/10 09:15'); // janela fecha 09:50; 35 min antes
  assert.equal(f(p.janelaFim), '06/10 09:50');
});

test('exemplo do Matheus: proposta às 17h é cobrada às 9h do dia seguinte', () => {
  const p = planejar({ propostaEm: sp('2026-10-05 17:00'), ultimoClienteEm: sp('2026-10-05 16:50'), horario: h });
  assert.equal(f(p.primeira), '06/10 09:00');
  assert.equal(f(p.segunda), '06/10 16:15');
});

test('2ª cobrança fora do expediente vai para as 17h30 do dia anterior', () => {
  // Cliente escreveu às 20h; a janela fecha às 20h do dia seguinte.
  const p = planejar({ propostaEm: sp('2026-10-06 09:30'), ultimoClienteEm: sp('2026-10-05 20:00'), horario: h });
  assert.equal(f(p.primeira), '06/10 11:30');
  assert.equal(f(p.segunda), '06/10 17:30');
});

test('janela fecha antes das 2 horas úteis: uma única cobrança, no último horário', () => {
  // Cliente escreveu às 8h, proposta saiu às 16h30. Janela fecha às 8h do dia seguinte.
  const p = planejar({ propostaEm: sp('2026-10-05 16:30'), ultimoClienteEm: sp('2026-10-05 08:00'), horario: h });
  assert.equal(f(p.primeira), '05/10 17:30');
  assert.equal(p.segunda, null);
});

test('sábado à tarde: cobra no sábado às 17h30, não espera segunda', () => {
  const p = planejar({ propostaEm: sp('2026-10-10 16:00'), ultimoClienteEm: sp('2026-10-10 15:50'), horario: h });
  assert.equal(f(p.primeira), '10/10 17:30');
  assert.equal(p.segunda, null);
});

test('sem tempo útil antes de a janela fechar: não cobra', () => {
  // Proposta às 17h25 e a janela fecha às 8h: só sobrariam 5 minutos.
  const p = planejar({ propostaEm: sp('2026-10-05 17:25'), ultimoClienteEm: sp('2026-10-05 08:00'), horario: h });
  assert.equal(p.primeira, null);
  assert.equal(p.segunda, null);
});

test('1ª e 2ª cairiam juntas: fica só a 1ª', () => {
  // Janela fecha 12:30. 1ª = 12:00, última chance = 11:55 (antes da 1ª).
  const p = planejar({ propostaEm: sp('2026-10-05 10:00'), ultimoClienteEm: sp('2026-10-04 12:30'), horario: h });
  assert.equal(f(p.primeira), '05/10 12:00');
  assert.equal(p.segunda, null);
});

test('última mensagem do cliente desconhecida: só a 1ª cobrança', () => {
  const p = planejar({ propostaEm: sp('2026-10-05 10:00'), ultimoClienteEm: null, horario: h });
  assert.equal(f(p.primeira), '05/10 12:00');
  assert.equal(p.segunda, null);
  assert.equal(p.janelaFim, null);
});

test('nenhuma cobrança sai fora do horário, em nenhum cenário', () => {
  for (let dia = 5; dia <= 11; dia++) {
    for (let hora = 0; hora < 24; hora++) {
      for (const atraso of [10, 60, 300, 900, 1380]) {
        const propostaEm = sp(`2026-10-${String(dia).padStart(2, '0')} ${String(hora).padStart(2, '0')}:10`);
        const p = planejar({ propostaEm, ultimoClienteEm: propostaEm - atraso * 60_000, horario: h });
        for (const t of [p.primeira, p.segunda]) {
          if (t == null) continue;
          assert.ok(h.aberto(t), `fora do horário: ${f(t)}`);
          assert.ok(t < p.janelaFim, 'depois da janela');
          assert.ok(t >= propostaEm + 30 * 60_000, 'cedo demais');
        }
        if (p.primeira && p.segunda) assert.ok(p.segunda >= p.primeira + 3_600_000);
      }
    }
  }
});
