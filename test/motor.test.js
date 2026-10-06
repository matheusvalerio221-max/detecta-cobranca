import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarHorario } from '../src/horario.js';
import { criarMotor } from '../src/motor.js';
import { primeiroNome, textoPadrao } from '../src/ia.js';
import { sp } from './util.js';

const quieto = { info() {}, warn() {}, error() {} };

function cenario(cfg = {}) {
  const db = abrirBanco(':memory:');
  const relogio = { t: sp('2026-10-05 09:00') };
  const enviados = [];
  const notas = [];
  let falhar = false;
  const bradial = {
    async enviarTexto(a) {
      if (falhar) throw new Error('HTTP 400: janela fechada');
      enviados.push(a);
    },
    async notaPrivada(a) {
      notas.push(a);
    },
  };
  const ia = { redigir: async ({ contato, numero }) => ({ texto: textoPadrao({ contato, numero }), origem: 'padrao' }) };
  const motor = criarMotor({ db, horario: criarHorario(), bradial, ia, agora: () => relogio.t, log: quieto, cfg: { modo: 'auto', caixasPermitidas: [12530], ...cfg } });
  let seq = 1000;
  // Monta um evento message_created no formato do Bradial.
  const msg = ({ em, tipo = 'incoming', texto = '', anexo, privada = false, autor, conversa = 500, inbox = 12530, remetente }) => ({
    event: 'message_created',
    id: seq++,
    content: texto,
    message_type: tipo,
    private: privada,
    created_at: Math.floor(sp(em) / 1000),
    sender: remetente === null ? null : tipo === 'incoming' ? { type: 'contact', name: 'Marcel' } : { type: 'user', name: autor || 'Carolinne Minatel' },
    attachments: anexo ? [{ file_type: 'file', data_url: `https://arquivos.exemplo/blobs/abc/${encodeURIComponent(anexo)}` }] : [],
    conversation: {
      id: conversa,
      inbox_id: inbox,
      status: 'open',
      can_reply: true,
      meta: { sender: { name: 'Marcel', phone_number: '+5519999990000' }, assignee: { name: 'Carolinne Minatel' } },
    },
  });
  const ir = async (quando) => {
    relogio.t = sp(quando);
    return motor.tick();
  };
  return { db, motor, msg, ir, enviados, notas, relogio, quebrarEnvio: () => (falhar = true) };
}

test('fluxo completo: proposta, 1ª cobrança, 2ª cobrança, sem resposta', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'Preciso de um orçamento' }));
  const r = await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PC10-001 SUMITOMO ELETRIC.pdf' }));
  assert.equal(r, 'proposta');

  assert.equal(await c.ir('2026-10-05 11:59'), 0, 'antes das 2 horas não cobra');
  assert.equal(await c.ir('2026-10-05 12:00'), 1);
  assert.equal(c.enviados.length, 1);
  assert.equal(c.enviados[0].inboxId, 12530);
  assert.equal(c.enviados[0].telefone, '+5519999990000');
  assert.match(c.enviados[0].texto, /Olá, Marcel!/);

  assert.equal(await c.ir('2026-10-05 15:00'), 0, 'não repete');
  assert.equal(await c.ir('2026-10-06 09:14'), 0);
  assert.equal(await c.ir('2026-10-06 09:15'), 1, '2ª cobrança 35 min antes de fechar a janela');
  assert.equal(c.enviados.length, 2);

  await c.ir('2026-10-06 09:51');
  const cob = c.db.get('SELECT * FROM cobrancas');
  assert.equal(cob.estado, 'sem_resposta');
  assert.match(c.notas.at(-1).texto, /não respondeu/);
});

test('cliente responde: para de cobrar e avisa a atendente', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184 BONSUCESSO.pdf' }));
  await c.ir('2026-10-05 12:00');
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 12:20', texto: 'Vou aprovar, pode agendar' }));
  assert.equal(c.db.get('SELECT estado FROM cobrancas').estado, 'respondida');
  assert.match(c.notas.at(-1).texto, /cliente respondeu/);
  assert.equal(await c.ir('2026-10-06 09:15'), 0);
  assert.equal(c.enviados.length, 1);
});

test('cliente responde antes da 1ª cobrança: nada é enviado e nenhuma nota é gravada', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:30', texto: 'Recebi, obrigado' }));
  assert.equal(await c.ir('2026-10-05 12:00'), 0);
  assert.equal(c.enviados.length, 0);
  assert.equal(c.notas.length, 0);
});

test('atendente retoma a conversa: cobrança é cancelada', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  // Mensagem logo depois da proposta faz parte do envio, não é retomada.
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:02', tipo: 'outgoing', texto: 'Segue a proposta em anexo' }));
  assert.equal(c.db.get('SELECT estado FROM cobrancas').estado, 'ativa');
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 11:30', tipo: 'outgoing', texto: 'Marcel, conseguiu ver?' }));
  assert.equal(c.db.get('SELECT estado FROM cobrancas').estado, 'retomada');
  assert.equal(await c.ir('2026-10-05 12:00'), 0);
});

test('eco da nossa própria cobrança não conta como atendente retomando', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.ir('2026-10-05 12:00');
  const eco = c.msg({ em: '2026-10-05 12:00', tipo: 'outgoing', texto: c.enviados[0].texto, autor: 'Admin (Detecta)' });
  assert.equal(await c.motor.receberEvento(eco), 'auto');
  assert.equal(c.db.get('SELECT estado FROM cobrancas').estado, 'ativa');
  assert.equal(await c.ir('2026-10-06 09:15'), 1, '2ª cobrança continua de pé');
});

test('robô de menu, nota privada, PDF que não é proposta e outra caixa não disparam nada', async () => {
  const c = cenario();
  assert.equal(await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', texto: 'Seja bem-vindo! Escolha uma opção', remetente: null })), 'sistema');
  assert.equal(await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:01', tipo: 'outgoing', privada: true, texto: 'PE09-184', anexo: 'PE09-184.pdf' })), 'privada');
  assert.equal(await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:02', tipo: 'outgoing', anexo: 'certificado-desinsetizacao.pdf' })), 'atendente');
  assert.equal(await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:03', tipo: 'outgoing', anexo: 'PE09-184.pdf', inbox: 210 })), 'ignorada');
  assert.equal(c.db.get('SELECT COUNT(*) n FROM cobrancas').n, 0);
});

test('modo sombra: não envia ao cliente, grava sugestão como nota privada', async () => {
  const c = cenario({ modo: 'sombra' });
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  assert.equal(await c.ir('2026-10-05 12:00'), 1);
  assert.equal(c.enviados.length, 0);
  assert.equal(c.notas.length, 1);
  assert.match(c.notas[0].texto, /NÃO enviada ao cliente/);
  assert.equal(c.notas[0].conversaId, 500);
});

test('filtro de teste por telefone: só age no número liberado', async () => {
  const c = cenario({ somenteTelefones: ['5519988887777'] });
  assert.equal(await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' })), 'ignorada');
  const c2 = cenario({ somenteTelefones: ['19999990000'] });
  assert.equal(await c2.motor.receberEvento(c2.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' })), 'proposta');
});

test('falha no envio: registra o erro, avisa a atendente e não tenta de novo', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  c.quebrarEnvio();
  await c.ir('2026-10-05 12:00');
  assert.match(c.db.get('SELECT ultimo_erro FROM cobrancas').ultimo_erro, /janela fechada/);
  assert.match(c.notas.at(-1).texto, /não consegui enviar/);
  assert.equal(await c.ir('2026-10-05 12:01'), 0);
});

test('serviço parado durante a noite: cobrança vencida só sai no horário comercial', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 16:50', texto: 'aguardo' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 17:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  assert.equal(await c.ir('2026-10-05 20:00'), 0);
  assert.equal(await c.ir('2026-10-06 08:30'), 0);
  assert.equal(await c.ir('2026-10-06 09:00'), 1);
});

test('nova proposta na mesma conversa reinicia a contagem', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 11:00', tipo: 'outgoing', anexo: 'PE09-184 rev1.pdf' }));
  assert.equal(await c.ir('2026-10-05 12:00'), 0);
  assert.equal(await c.ir('2026-10-05 13:00'), 1);
  assert.deepEqual(c.db.all('SELECT estado FROM cobrancas ORDER BY id').map((x) => x.estado), ['substituida', 'ativa']);
});

test('conversa finalizada encerra a cobrança', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento({ event: 'conversation_status_changed', id: 500, inbox_id: 12530, status: 'resolved', meta: { sender: { name: 'Marcel', phone_number: '+5519999990000' } } });
  assert.equal(c.db.get('SELECT estado FROM cobrancas').estado, 'encerrada');
});

test('nome do contato: pessoa vira primeiro nome, setor não vira nome', () => {
  assert.equal(primeiroNome('Marcel'), 'Marcel');
  assert.equal(primeiroNome('Daniel Honório - Dux'), 'Daniel');
  assert.equal(primeiroNome('Mirna - ABL Sumaré'), 'Mirna');
  assert.equal(primeiroNome('Compras - Bonsucesso'), '');
  assert.equal(primeiroNome('RH (AMANDA)'), '');
  assert.equal(primeiroNome('BrasPoint'), '');
  assert.equal(primeiroNome('joão silva'), 'João');
  assert.equal(primeiroNome('TRB BR - Suprimentos William'), '');
  assert.equal(primeiroNome(''), '');
});
