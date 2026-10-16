// Banco SQLite embutido do Node 22 (sem dependências externas).
import { DatabaseSync } from 'node:sqlite';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS conversas (
  id INTEGER PRIMARY KEY,            -- número do atendimento no Bradial (display id)
  inbox_id INTEGER,
  contato TEXT,
  telefone TEXT,
  atendente TEXT,
  status TEXT,
  pode_responder INTEGER,            -- último can_reply informado pelo Bradial
  ultimo_cliente_em INTEGER,
  ultimo_atendente_em INTEGER,
  atualizado_em INTEGER
);
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY,
  conversa_id INTEGER NOT NULL,
  em INTEGER NOT NULL,
  tipo TEXT NOT NULL,                -- cliente | atendente | auto | privada | sistema
  autor TEXT,
  texto TEXT,
  anexos TEXT
);
CREATE INDEX IF NOT EXISTS mensagens_conversa ON mensagens (conversa_id, em);
CREATE TABLE IF NOT EXISTS cobrancas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id INTEGER NOT NULL,
  proposta_em INTEGER NOT NULL,
  proposta_arquivo TEXT,
  atendente TEXT,
  primeira_em INTEGER,
  segunda_em INTEGER,
  janela_fim INTEGER,
  primeira_enviada_em INTEGER,
  segunda_enviada_em INTEGER,
  estado TEXT NOT NULL DEFAULT 'ativa', -- ativa | respondida | retomada | encerrada | sem_resposta | substituida
  encerrada_em INTEGER,
  ultimo_erro TEXT
);
CREATE INDEX IF NOT EXISTS cobrancas_estado ON cobrancas (estado);
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cobranca_id INTEGER NOT NULL,
  conversa_id INTEGER NOT NULL,
  em INTEGER NOT NULL,
  numero INTEGER NOT NULL,           -- 1 ou 2
  modo TEXT NOT NULL,                -- sombra | auto
  origem_texto TEXT,                 -- ia | padrao
  texto TEXT NOT NULL,
  ok INTEGER NOT NULL,
  erro TEXT
);
CREATE TABLE IF NOT EXISTS eventos_brutos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  em INTEGER NOT NULL,
  evento TEXT,
  corpo TEXT
);
`;

// Colunas acrescentadas depois da primeira versão (ALTER TABLE só se faltar).
const EXTRAS = [
  ['cobrancas', 'plano TEXT'], // JSON: horários previstos das cobranças que faltam
  ['cobrancas', 'etapa INTEGER NOT NULL DEFAULT 0'], // quantas já saíram
  ['cobrancas', 'ultima_enviada_em INTEGER'],
  ['cobrancas', 'classificacao TEXT'], // última leitura da resposta do cliente
  ['envios', 'canal TEXT'], // texto | modelo
];

export function abrirBanco(caminho) {
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(ESQUEMA);
  for (const [tabela, coluna] of EXTRAS) {
    const nome = coluna.split(' ')[0];
    const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === nome);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna}`);
  }
  // Cobranças abertas pela versão anterior: converte 1ª/2ª no novo plano.
  for (const c of db.prepare("SELECT * FROM cobrancas WHERE plano IS NULL AND estado = 'ativa'").all()) {
    const plano = [c.primeira_enviada_em ? null : c.primeira_em, c.segunda_enviada_em ? null : c.segunda_em].filter((t) => t != null);
    const etapa = (c.primeira_enviada_em ? 1 : 0) + (c.segunda_enviada_em ? 1 : 0);
    db.prepare('UPDATE cobrancas SET plano = ?, etapa = ?, ultima_enviada_em = ? WHERE id = ?').run(
      JSON.stringify(plano), etapa, c.segunda_enviada_em || c.primeira_enviada_em || null, c.id,
    );
  }
  const q = (sql) => db.prepare(sql);
  return {
    raw: db,
    get: (sql, ...a) => q(sql).get(...a),
    all: (sql, ...a) => q(sql).all(...a),
    run: (sql, ...a) => q(sql).run(...a),
  };
}
