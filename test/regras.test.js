import test from 'node:test';
import assert from 'node:assert/strict';
import { criarHorario } from '../src/horario.js';
import { planejar, janelaAberta } from '../src/regras.js';

import { sp } from './util.js';

const h = criarHorario();
const f = (t) => (t == null ? null : h.formatar(t));
const fs = (ts) => ts.map(f);

test('horário: aberto de segunda a sábado, 9h às 17h30', () => {
  assert.equal(h.aberto(sp('2026-10-05 09:00')), true);
  assert.equal(h.aberto(sp('2026-10-05 17:30')), true);
  assert.equal(h.aberto(sp('2026-10-05 08:59')), false);
  assert.equal(h.aberto(sp('2026-10-05 17:31')), false);
  assert.equal(h.aberto(sp('2026-10-10 10:00')), true, 'sábado');
  assert.equal(h.aberto(sp('2026-10-11 10:00')), false, 'domingo');
});

test('horário: próximo, anterior e próximo dia', () => {
  assert.equal(f(h.proximo(sp('2026-10-05 19:00'))), '06/10 09:00');
  assert.equal(f(h.proximo(sp('2026-10-05 07:00'))), '05/10 09:00');
  assert.equal(f(h.proximo(sp('2026-10-05 11:20'))), '05/10 11:20');
  assert.equal(f(h.proximo(sp('2026-10-10 18:00'))), '12/10 09:00', 'sábado à noite vai para segunda');
  assert.equal(f(h.anterior(sp('2026-10-06 07:25'))), '05/10 17:30');
  assert.equal(f(h.anterior(sp('2026-10-11 15:00'))), '10/10 17:30', 'domingo volta para sábado');
  assert.equal(f(h.anterior(sp('2026-10-05 12:00'))), '05/10 12:00');
  assert.equal(f(h.proximoDia(sp('2026-10-05 12:00'))), '06/10 09:00');
  assert.equal(f(h.proximoDia(sp('2026-10-10 12:00'))), '12/10 09:00', 'de sábado pula para segunda');
});

test('horário: feriado é pulado', () => {
  const hf = criarHorario({ feriados: ['2026-10-12'] });
  assert.equal(hf.formatar(hf.proximo(sp('2026-10-10 18:00'))), '13/10 09:00');
});

test('sem modelo: proposta de manhã dá 1ª em 2h, 2ª 4h depois e a última antes de fechar a janela', () => {
  const p = planejar({ inicioEm: sp('2026-10-05 10:00'), ultimoClienteEm: sp('2026-10-05 09:50'), horario: h });
  assert.deepEqual(fs(p.etapas), ['05/10 12:00', '05/10 16:00', '06/10 09:15']); // 3ª (06/10 09:00) e 4ª (09:15) ficaram a menos de 1h: fica a última
  assert.equal(f(p.janelaFim), '06/10 09:50');
});

test('com modelo: 4 cobranças, as de fora da janela ficam para o modelo', () => {
  const p = planejar({ inicioEm: sp('2026-10-05 10:00'), ultimoClienteEm: sp('2026-10-05 09:50'), horario: h, comModelo: true });
  assert.deepEqual(fs(p.etapas), ['05/10 12:00', '05/10 16:00', '06/10 09:15', '07/10 09:00']);
});

test('exemplo do Matheus: proposta às 17h é cobrada às 9h do dia seguinte', () => {
  const p = planejar({ inicioEm: sp('2026-10-05 17:00'), ultimoClienteEm: sp('2026-10-05 16:50'), horario: h, comModelo: true });
  assert.deepEqual(fs(p.etapas), ['06/10 09:00', '06/10 13:00', '06/10 16:15', '07/10 09:00']);
});

test('cobrança fora do expediente vai para as 17h30 do dia anterior', () => {
  // Cliente escreveu às 20h; a janela fecha às 20h do dia seguinte.
  const p = planejar({ inicioEm: sp('2026-10-06 09:30'), ultimoClienteEm: sp('2026-10-05 20:00'), horario: h });
  assert.deepEqual(fs(p.etapas), ['06/10 11:30', '06/10 15:30', '06/10 17:30']);
});

test('janela fecha antes das 2 horas úteis: uma única cobrança, no último horário', () => {
  // Cliente escreveu às 8h, proposta saiu às 16h30. Janela fecha às 8h do dia seguinte.
  const p = planejar({ inicioEm: sp('2026-10-05 16:30'), ultimoClienteEm: sp('2026-10-05 08:00'), horario: h });
  assert.deepEqual(fs(p.etapas), ['05/10 17:30']);
  const pm = planejar({ inicioEm: sp('2026-10-05 16:30'), ultimoClienteEm: sp('2026-10-05 08:00'), horario: h, comModelo: true });
  assert.deepEqual(fs(pm.etapas), ['05/10 17:30', '06/10 09:00', '06/10 13:00', '07/10 09:00'], 'com modelo, a última chance da janela vira a 1ª');
});

test('sábado à tarde: cobra no sábado às 17h30, não espera segunda', () => {
  const p = planejar({ inicioEm: sp('2026-10-10 16:00'), ultimoClienteEm: sp('2026-10-10 15:50'), horario: h });
  assert.deepEqual(fs(p.etapas), ['10/10 17:30']);
});

test('sem tempo útil antes de a janela fechar e sem modelo: não cobra', () => {
  // Proposta às 17h25 e a janela fecha às 8h: só sobrariam 5 minutos.
  const p = planejar({ inicioEm: sp('2026-10-05 17:25'), ultimoClienteEm: sp('2026-10-05 08:00'), horario: h });
  assert.deepEqual(p.etapas, []);
});

test('última mensagem do cliente desconhecida: sem modelo só a 1ª; com modelo todas', () => {
  const p = planejar({ inicioEm: sp('2026-10-05 10:00'), ultimoClienteEm: null, horario: h });
  assert.deepEqual(fs(p.etapas), ['05/10 12:00']);
  assert.equal(p.janelaFim, null);
  const pm = planejar({ inicioEm: sp('2026-10-05 10:00'), ultimoClienteEm: null, horario: h, comModelo: true });
  assert.deepEqual(fs(pm.etapas), ['05/10 12:00', '05/10 16:00', '06/10 09:00', '07/10 09:00']);
});

test('replanejar: cliente só confirmou recebimento -> recomeça a contagem de agora; pediu tempo -> dia útil seguinte', () => {
  const p = planejar({ inicioEm: sp('2026-10-05 12:20'), ultimoClienteEm: sp('2026-10-05 12:20'), horario: h, comModelo: true, quantas: 3 });
  assert.deepEqual(fs(p.etapas), ['05/10 14:20', '06/10 09:00', '06/10 11:45']);
  const a = planejar({ inicioEm: sp('2026-10-05 12:20'), ultimoClienteEm: sp('2026-10-05 12:20'), horario: h, comModelo: true, quantas: 3, adiar: true });
  assert.deepEqual(fs(a.etapas), ['06/10 09:00', '06/10 11:45', '06/10 13:00']);
});

test('janela aberta: até 5 minutos antes de completar 24h da última mensagem do cliente', () => {
  const ult = sp('2026-10-05 09:50');
  assert.equal(janelaAberta({ ultimoClienteEm: ult, t: sp('2026-10-06 09:44') }), true);
  assert.equal(janelaAberta({ ultimoClienteEm: ult, t: sp('2026-10-06 09:46') }), false);
  assert.equal(janelaAberta({ ultimoClienteEm: null, t: sp('2026-10-06 09:46') }), false);
});

test('nenhuma cobrança sai fora do horário, em nenhum cenário', () => {
  for (const comModelo of [false, true]) {
    for (let dia = 5; dia <= 11; dia++) {
      for (let hora = 0; hora < 24; hora++) {
        for (const atraso of [10, 60, 300, 900, 1380]) {
          const inicioEm = sp(`2026-10-${String(dia).padStart(2, '0')} ${String(hora).padStart(2, '0')}:10`);
          const p = planejar({ inicioEm, ultimoClienteEm: inicioEm - atraso * 60_000, horario: h, comModelo });
          assert.ok(p.etapas.length <= 4);
          let ant = null;
          for (const t of p.etapas) {
            assert.ok(h.aberto(t), `fora do horário: ${f(t)}`);
            assert.ok(t >= inicioEm + 30 * 60_000, 'cedo demais');
            if (!comModelo) assert.ok(t < p.janelaFim, 'depois da janela');
            if (ant != null) assert.ok(t >= ant + 3_600_000, 'menos de 1h entre cobranças');
            ant = t;
          }
        }
      }
    }
  }
});
