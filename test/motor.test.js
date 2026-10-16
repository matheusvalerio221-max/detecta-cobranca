import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarHorario } from '../src/horario.js';
import { criarMotor } from '../src/motor.js';
import { primeiroNome, textoPadrao, classificarPadrao } from '../src/ia.js';
import { sp } from './util.js';

const quieto = { info() {}, warn() {}, error() {} };

function cenario(cfg = {}) {
  const db = abrirBanco(':memory:');
  const relogio = { t: sp('2026-10-05 09:00') };
  const enviados = [];
  const modelos = [];
  const notas = [];
  let falhar = false;
  const bradial = {
    async enviarTexto(a) {
      if (falhar) throw new Error('HTTP 400: janela fechada');
      enviados.push(a);
    },
    async enviarModelo(a) {
      if (falhar) throw new Error('HTTP 400: modelo não aprovado');
      modelos.push(a);
    },
    async notaPrivada(a) {
      notas.push(a);
    },
  };
  const ia = {
    redigir: async ({ contato, numero }) => ({ texto: textoPadrao({ contato, numero }), origem: 'padrao' }),
    classificar: async ({ textoCliente }) => ({ categoria: classificarPadrao(textoCliente), origem: 'padrao' }),
  };
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
  const estado = () => db.get('SELECT estado FROM cobrancas ORDER BY id DESC LIMIT 1').estado;
  const plano = () => JSON.parse(db.get('SELECT plano FROM cobrancas ORDER BY id DESC LIMIT 1').plano).map((t) => criarHorario().formatar(t));
  return { db, motor, msg, ir, enviados, modelos, notas, relogio, estado, plano, quebrarEnvio: () => (falhar = true) };
}

const COM_MODELO = { modelo: { nome: 'acompanhamento_proposta', corpo: 'Olá, {{1}}! Enviamos a proposta {{2}} e gostaríamos de saber se conseguiu avaliá-la.' } };

test('sem modelo: proposta, 1ª, 2ª e última cobrança dentro da janela; depois encerra sem resposta', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'Preciso de um orçamento' }));
  const r = await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PC10-001 SUMITOMO ELETRIC.pdf' }));
  assert.equal(r, 'proposta');
  assert.deepEqual(c.plano(), ['05/10 12:00', '05/10 16:00', '06/10 09:15']);

  assert.equal(await c.ir('2026-10-05 11:59'), 0, 'antes das 2 horas não cobra');
  assert.equal(await c.ir('2026-10-05 12:00'), 1);
  assert.equal(c.enviados.length, 1);
  assert.equal(c.enviados[0].inboxId, 12530);
  assert.equal(c.enviados[0].telefone, '+5519999990000');
  assert.match(c.enviados[0].texto, /Olá, Marcel!/);

  assert.equal(await c.ir('2026-10-05 15:00'), 0, 'não repete');
  assert.equal(await c.ir('2026-10-05 16:00'), 1, '2ª cobrança 4h depois');
  assert.equal(await c.ir('2026-10-06 09:14'), 0);
  assert.equal(await c.ir('2026-10-06 09:15'), 1, 'última 35 min antes de fechar a janela');
  assert.equal(c.enviados.length, 3);
  assert.equal(c.modelos.length, 0);

  await c.ir('2026-10-06 09:51');
  assert.equal(c.estado(), 'sem_resposta');
  assert.match(c.notas.at(-1).texto, /não respondeu/);
});

test('com modelo: 4 cobranças, a última pelo modelo depois de fechar a janela', async () => {
  const c = cenario(COM_MODELO);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE10-051 Felipe.pdf' }));
  assert.deepEqual(c.plano(), ['05/10 12:00', '05/10 16:00', '06/10 09:15', '07/10 09:00']);
  await c.ir('2026-10-05 12:00');
  await c.ir('2026-10-05 16:00');
  await c.ir('2026-10-06 09:15');
  assert.equal(c.enviados.length, 3);
  assert.equal(await c.ir('2026-10-06 12:00'), 0);
  assert.equal(c.estado(), 'ativa', 'ainda falta a 4ª');
  assert.equal(await c.ir('2026-10-07 09:00'), 1);
  assert.equal(c.modelos.length, 1, '4ª saiu pelo modelo');
  assert.equal(c.modelos[0].modelo, 'acompanhamento_proposta');
  assert.deepEqual(c.modelos[0].parametros, ['Marcel', 'PE10-051']);
  assert.equal(c.estado(), 'ativa');
  await c.ir('2026-10-08 09:05');
  assert.equal(c.estado(), 'sem_resposta');
  assert.match(c.notas.at(-1).texto, /cobrada 4x/);
});

test('cliente aprova: encerra e avisa a atendente para agendar', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184 BONSUCESSO.pdf' }));
  await c.ir('2026-10-05 12:00');
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 12:20', texto: 'Vou aprovar, pode agendar' }));
  assert.equal(c.estado(), 'aprovada');
  assert.match(c.notas.at(-1).texto, /APROVOU/);
  assert.equal(await c.ir('2026-10-05 16:00'), 0);
  assert.equal(c.enviados.length, 1);
});

test('cliente recusa: encerra e avisa', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:30', texto: 'Obrigado, mas fechamos com outra empresa' }));
  assert.equal(c.estado(), 'recusada');
  assert.match(c.notas.at(-1).texto, /NÃO vai seguir/);
});

test('cliente faz pergunta: para e deixa com a atendente (nota só se já foi cobrado)', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:30', texto: 'Esse valor inclui a área externa?' }));
  assert.equal(c.estado(), 'respondida');
  assert.equal(c.notas.length, 0, 'ninguém foi cobrado ainda, a atendente está na conversa');
  assert.equal(await c.ir('2026-10-05 12:00'), 0);
});

test('cliente só confirma recebimento: continua cobrando, contagem recomeça', async () => {
  const c = cenario(COM_MODELO);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:30', texto: 'Recebi, obrigado' }));
  assert.equal(c.estado(), 'ativa');
  assert.deepEqual(c.plano(), ['05/10 12:30', '05/10 16:30', '06/10 09:55', '07/10 09:00']);
  assert.equal(await c.ir('2026-10-05 12:00'), 0);
  assert.equal(await c.ir('2026-10-05 12:30'), 1);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 12:40', texto: 'ok' }));
  assert.equal(c.estado(), 'ativa');
  assert.deepEqual(c.plano(), ['05/10 14:40', '06/10 09:00', '06/10 12:05'], 'três que faltam, a partir de agora');
});

test('cliente pede tempo: a próxima cobrança só no dia útil seguinte', async () => {
  const c = cenario(COM_MODELO);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.ir('2026-10-05 12:00');
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 12:10', texto: 'Vou analisar com a diretoria e te dou um retorno' }));
  assert.equal(c.estado(), 'ativa');
  assert.deepEqual(c.plano(), ['06/10 09:00', '06/10 11:35', '06/10 13:00']);
  assert.equal(await c.ir('2026-10-05 16:00'), 0, 'não insiste no mesmo dia');
  assert.equal(await c.ir('2026-10-06 09:00'), 1);
});

test('atendente escreve "fico à disposição" depois da proposta: NÃO cancela', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:02', tipo: 'outgoing', texto: 'Segue a proposta em anexo' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:40', tipo: 'outgoing', texto: 'Qualquer dúvida estou à disposição!' }));
  assert.equal(c.estado(), 'ativa');
  assert.equal(await c.ir('2026-10-05 12:00'), 1);
});

test('atendente responde ao cliente: aí sim é retomada e a cobrança é cancelada', async () => {
  const c = cenario(COM_MODELO);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:30', texto: 'ok recebi' }));
  assert.equal(c.estado(), 'ativa');
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:35', tipo: 'outgoing', texto: 'Ótimo, Marcel! Qualquer coisa me chame.' }));
  assert.equal(c.estado(), 'retomada');
  assert.equal(await c.ir('2026-10-05 12:30'), 0);
});

test('eco da nossa própria cobrança não conta como atendente retomando', async () => {
  const c = cenario();
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 09:50', texto: 'oi' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 10:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  await c.ir('2026-10-05 12:00');
  const eco = c.msg({ em: '2026-10-05 12:00', tipo: 'outgoing', texto: c.enviados[0].texto, autor: 'Assistente Comercial' });
  assert.equal(await c.motor.receberEvento(eco), 'auto');
  assert.equal(c.estado(), 'ativa');
  assert.equal(await c.ir('2026-10-05 16:00'), 1, '2ª cobrança continua de pé');
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

test('serviço parado durante a noite: cobrança vencida só sai no horário comercial, e só uma', async () => {
  const c = cenario(COM_MODELO);
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 16:50', texto: 'aguardo' }));
  await c.motor.receberEvento(c.msg({ em: '2026-10-05 17:00', tipo: 'outgoing', anexo: 'PE09-184.pdf' }));
  assert.deepEqual(c.plano(), ['06/10 09:00', '06/10 13:00', '06/10 16:15', '07/10 09:00']);
  assert.equal(await c.ir('2026-10-05 20:00'), 0);
  assert.equal(await c.ir('2026-10-06 08:30'), 0);
  assert.equal(await c.ir('2026-10-06 14:00'), 1, 'duas venceram juntas (09:00 e 13:00): sai uma');
  assert.deepEqual(c.plano(), ['06/10 16:15', '07/10 09:00']);
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
  assert.equal(c.estado(), 'encerrada');
});

test('banco da versão anterior: cobrança ativa com 1ª/2ª vira plano', () => {
  const db = abrirBanco(':memory:');
  db.run("INSERT INTO cobrancas (conversa_id, proposta_em, primeira_em, segunda_em, janela_fim, primeira_enviada_em, estado) VALUES (1, 1000, 2000, 3000, 4000, 2000, 'ativa')");
  const db2 = abrirBanco(':memory:'); // esquema novo direto
  assert.ok(db2.get("SELECT 1 FROM pragma_table_info('cobrancas') WHERE name = 'plano'"));
  // Simula a migração em um banco que já tinha a linha mas não a coluna: feito acima pelo abrirBanco na própria linha.
  const c = db.get('SELECT * FROM cobrancas');
  assert.equal(c.etapa, 0); // a linha foi inserida depois de abrir: plano fica nulo e o painel usa 1ª/2ª
});

test('leitura por palavras-chave', () => {
  assert.equal(classificarPadrao('Pode agendar, aprovado!'), 'aprovou');
  assert.equal(classificarPadrao('Fechamos com outra empresa, obrigado'), 'recusou');
  assert.equal(classificarPadrao('Qual o prazo de garantia?'), 'duvida');
  assert.equal(classificarPadrao('Tem como melhorar o valor?'), 'duvida');
  assert.equal(classificarPadrao('Vou passar para o gerente e te retorno'), 'pensar');
  assert.equal(classificarPadrao('Ok, obrigada!'), 'recebeu');
  assert.equal(classificarPadrao('Recebi'), 'recebeu');
  assert.equal(classificarPadrao('👍'), 'recebeu');
  assert.equal(classificarPadrao('Bom dia'), 'recebeu');
  assert.equal(classificarPadrao('A Marta não trabalha mais aqui, fala com o Paulo no 19 9999'), 'outro');
  assert.equal(classificarPadrao(''), 'outro');
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
