// Detecta Cobrança — acompanhamento automático de propostas enviadas pelo Bradial Chat.
// Node 22, sem dependências externas.
//
// Rotas (todas sob /cobranca):
//   POST /webhook            recebe eventos do Bradial (header x-webhook-secret)
//   GET  /painel             acompanhamento das cobranças (usuário "detecta" + senha)
//   GET  /configurar         chaves, modo de envio e horários (mesma senha)
//   GET  /saude              verificação simples, sem dados
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { abrirBanco } from './db.js';
import { criarHorario } from './horario.js';
import { criarBradial } from './bradial.js';
import { criarIA } from './ia.js';
import { criarMotor } from './motor.js';

const env = process.env;
const lista = (v) => String(v || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

const PORTA = Number(env.PORT || 3100);
const BASE = '/cobranca';
const DATA_DIR = env.DATA_DIR || './data';
const SEGREDO = env.WEBHOOK_SECRET || '';
const SENHA_PAINEL = env.PAINEL_SENHA || '';
const PRONTO = SEGREDO.length >= 16 && SENHA_PAINEL.length >= 8;
if (!PRONTO) console.error('[cobranca] WEBHOOK_SECRET ou PAINEL_SENHA ausentes. Rode: bash /opt/detecta-rede/cobranca/setup.sh');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = abrirBanco(path.join(DATA_DIR, 'cobranca.sqlite'));
db.raw.exec('CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)');

// Configuração: o que foi salvo na tela vale mais que o padrão.
const PADRAO = {
  bradial_chave: env.BRADIAL_API_KEY || '',
  ia_chave: env.ANTHROPIC_API_KEY || '',
  ia_modelo: env.IA_MODELO || 'claude-sonnet-5-5',
  modo: env.COBRANCA_MODO === 'auto' ? 'auto' : 'sombra',
  somente_telefones: env.SOMENTE_TELEFONES || '',
  caixas: env.CAIXAS_PERMITIDAS || '12530,12101',
  horario_inicio: env.HORARIO_INICIO || '09:00',
  horario_fim: env.HORARIO_FIM || '17:30',
  dias_uteis: env.DIAS_UTEIS || '1,2,3,4,5,6',
  feriados: env.FERIADOS || '',
  agenda: env.AGENDA_TEXTO || '',
  proposta_regex: env.PROPOSTA_REGEX || 'P[A-Z]\\d{2}-\\d{3}',
  proposta_etiqueta: env.PROPOSTA_ETIQUETA || '',
};
function lerConfig() {
  const salvo = Object.fromEntries(db.all('SELECT chave, valor FROM config').map((l) => [l.chave, l.valor]));
  return { ...PADRAO, ...salvo };
}

let cfg;
let horario;
let bradial;
let motor;
function montar() {
  cfg = lerConfig();
  horario = criarHorario({
    offsetMin: Number(env.FUSO_MINUTOS || -180),
    inicio: cfg.horario_inicio,
    fim: cfg.horario_fim,
    dias: lista(cfg.dias_uteis).map(Number),
    feriados: lista(cfg.feriados),
  });
  bradial = criarBradial({ base: env.BRADIAL_API || 'https://api.bradial.com.br', chave: cfg.bradial_chave });
  const ia = criarIA({ chave: cfg.ia_chave, modelo: cfg.ia_modelo, agenda: cfg.agenda });
  let regex;
  try {
    regex = new RegExp(cfg.proposta_regex, 'i');
  } catch {
    regex = new RegExp(PADRAO.proposta_regex, 'i');
  }
  motor = criarMotor({
    db,
    horario,
    bradial,
    ia,
    cfg: {
      modo: cfg.modo === 'auto' ? 'auto' : 'sombra',
      regexProposta: regex,
      etiquetaProposta: cfg.proposta_etiqueta,
      caixasPermitidas: lista(cfg.caixas).map(Number).filter(Boolean),
      somenteTelefones: lista(cfg.somente_telefones),
    },
  });
}
montar();

const igual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

function lerCorpo(req, limite = 2_000_000) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (p) => {
      tam += p.length;
      if (tam > limite) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      } else partes.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const CSS = `body{font:14px system-ui,sans-serif;margin:24px;color:#1c2430;max-width:1200px}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e7ee;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f6f9}
.k{display:inline-block;margin:0 16px 16px 0;padding:10px 14px;background:#f4f6f9;border-radius:8px}.k b{display:block;font-size:20px}
.e-respondida{color:#0a7a3d;font-weight:600}.e-sem_resposta{color:#b3261e}.e-ativa{color:#8a5a00}
.modo{padding:2px 8px;border-radius:6px;font-size:13px}.m-auto{background:#d9f2e3}.m-sombra{background:#fff1cc}
nav a{margin-right:16px}label{display:block;margin:14px 0 4px;font-weight:600}input,select,textarea{font:inherit;padding:7px 9px;border:1px solid #c5ccd6;border-radius:6px;width:100%;max-width:520px;box-sizing:border-box}
small{color:#5b6675;display:block;margin-top:3px;max-width:640px}button{font:inherit;padding:9px 16px;border:0;border-radius:6px;background:#1d5fd1;color:#fff;cursor:pointer;margin-top:18px}
code{background:#f4f6f9;padding:2px 6px;border-radius:4px;word-break:break-all}.aviso{background:#fff1cc;padding:10px 14px;border-radius:8px;max-width:640px}.ok{background:#d9f2e3;padding:10px 14px;border-radius:8px;max-width:640px}.erro{background:#fbdcd9;padding:10px 14px;border-radius:8px;max-width:640px}`;

function pagina(titulo, corpo) {
  const m = cfg.modo === 'auto' ? 'auto' : 'sombra';
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} · Detecta Cobrança</title><style>${CSS}</style>
<h1>Detecta Cobrança <span class="modo m-${m}">${m === 'auto' ? 'modo automático: envia ao cliente' : 'modo teste: não envia ao cliente'}</span></h1>
<nav><a href="${BASE}/painel">Acompanhamento</a><a href="${BASE}/configurar">Configuração</a></nav>${corpo}</html>`;
}

function painel() {
  const linhas = db.all('SELECT c.*, v.contato FROM cobrancas c LEFT JOIN conversas v ON v.id = c.conversa_id ORDER BY c.id DESC LIMIT 200');
  const desde = Date.now() - 7 * 86_400_000;
  const conta = (estado) => db.get('SELECT COUNT(*) n FROM cobrancas WHERE proposta_em >= ? AND estado = ?', desde, estado).n;
  const total = db.get('SELECT COUNT(*) n FROM cobrancas WHERE proposta_em >= ?', desde).n;
  const enviadas = db.get('SELECT COUNT(*) n FROM envios WHERE em >= ? AND ok = 1', desde).n;
  const eventos = db.get('SELECT COUNT(*) n, MAX(em) ultimo FROM eventos_brutos');
  const rotulo = { ativa: 'Aguardando', respondida: 'Cliente respondeu', retomada: 'Atendente retomou', encerrada: 'Conversa finalizada', sem_resposta: 'Sem resposta', substituida: 'Nova proposta enviada' };
  const f = horario.formatar;
  const tr = linhas
    .map(
      (l) => `<tr><td>#${l.conversa_id}</td><td>${esc(l.contato)}</td><td>${esc(l.atendente)}</td><td>${esc(l.proposta_arquivo)}</td><td>${f(l.proposta_em)}</td>
<td>${l.primeira_enviada_em ? '✔ ' + f(l.primeira_enviada_em) : f(l.primeira_em)}</td><td>${l.segunda_enviada_em ? '✔ ' + f(l.segunda_enviada_em) : f(l.segunda_em)}</td>
<td>${f(l.janela_fim)}</td><td class="e-${l.estado}">${rotulo[l.estado] || l.estado}</td><td>${esc(l.ultimo_erro || '')}</td></tr>`,
    )
    .join('');
  const alerta = !cfg.bradial_chave
    ? `<p class="aviso">Falta a chave de API do Bradial. Abra <a href="${BASE}/configurar">Configuração</a>.</p>`
    : eventos.n === 0
      ? '<p class="aviso">Nenhum evento recebido do Bradial ainda. Confira o webhook em Configuração.</p>'
      : `<p>Último evento do Bradial: ${f(eventos.ultimo)}</p>`;
  return pagina(
    'Acompanhamento',
    `${alerta}<h2>Últimos 7 dias</h2>
<div><span class="k"><b>${total}</b>propostas detectadas</span><span class="k"><b>${enviadas}</b>cobranças feitas</span><span class="k"><b>${conta('respondida')}</b>clientes responderam</span>
<span class="k"><b>${conta('retomada')}</b>atendente retomou</span><span class="k"><b>${conta('sem_resposta')}</b>sem resposta</span><span class="k"><b>${conta('ativa')}</b>aguardando</span></div>
<table><tr><th>Conversa</th><th>Contato</th><th>Atendente</th><th>Proposta</th><th>Enviada</th><th>1ª cobrança</th><th>2ª cobrança</th><th>Janela fecha</th><th>Situação</th><th>Erro</th></tr>${tr}</table>
<p><small>Horários em Brasília. ✔ = cobrança já feita. Sem ✔ = horário previsto.</small></p>`,
  );
}

function configurar(req, aviso = '') {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const https = (req.headers['x-forwarded-proto'] || '') === 'https';
  const url = `${https ? 'https' : 'http'}://${host}${BASE}/webhook`;
  const sel = (v) => (cfg.modo === v ? ' selected' : '');
  return pagina(
    'Configuração',
    `${aviso}
${https ? '' : '<p class="erro">Esta página está sem HTTPS. Não salve chaves aqui até o endereço seguro (https) estar funcionando.</p>'}
<h2>1. Webhook no Bradial</h2>
<p>Em Configurações → Integrações → Webhook → Adicionar novo webhook:</p>
<p>URL do Webhook: <code>${esc(url)}</code></p>
<p>Header: nome <code>x-webhook-secret</code>, valor <code>${esc(SEGREDO)}</code></p>
<p>Eventos: <b>Mensagem criada</b> e <b>Status da conversa alterado</b>.</p>
<h2>2. Chaves e funcionamento</h2>
<form method="post" action="${BASE}/configurar" autocomplete="off">
<label>Chave de API do Bradial ${cfg.bradial_chave ? '— <span style="color:#0a7a3d">configurada ✔</span>' : '— <span style="color:#b3261e">faltando</span>'}</label>
<input type="password" name="bradial_chave" placeholder="${cfg.bradial_chave ? 'deixe em branco para manter a atual' : 'cole a chave de Configurações da conta'}">
<small>Fica em Bradial → Configurações → Configurações da conta → Chave de API.</small>
<label>Chave da IA (Anthropic) ${cfg.ia_chave ? '— configurada ✔' : '— opcional'}</label>
<input type="password" name="ia_chave" placeholder="${cfg.ia_chave ? 'deixe em branco para manter a atual' : 'opcional'}">
<small>Sem essa chave, a cobrança usa um texto padrão. Com ela, a mensagem é escrita com o contexto de cada conversa.</small>
<label>Modo de envio</label>
<select name="modo"><option value="sombra"${sel('sombra')}>Teste — grava a sugestão como nota privada, não envia ao cliente</option><option value="auto"${sel('auto')}>Automático — envia a cobrança ao cliente</option></select>
<label>Somente estes telefones (teste)</label>
<input name="somente_telefones" value="${esc(cfg.somente_telefones)}" placeholder="ex.: 5519999990000">
<small>Preenchido, o sistema só age em conversas desses números. Use o seu número para testar. Em branco = todos os clientes.</small>
<label>Caixas de entrada acompanhadas (IDs)</label>
<input name="caixas" value="${esc(cfg.caixas)}">
<small>12530 = Detecta 3245-0723, 12101 = Detecta. Ambas WhatsApp oficial.</small>
<label>Horário de envio</label>
<input name="horario_inicio" value="${esc(cfg.horario_inicio)}" style="max-width:120px"> até <input name="horario_fim" value="${esc(cfg.horario_fim)}" style="max-width:120px">
<label>Dias de envio</label>
<input name="dias_uteis" value="${esc(cfg.dias_uteis)}" style="max-width:200px">
<small>1 = segunda ... 6 = sábado, 0 = domingo.</small>
<label>Feriados sem envio</label>
<input name="feriados" value="${esc(cfg.feriados)}" placeholder="2026-10-12, 2026-11-02">
<label>Agenda que pode ser citada na cobrança</label>
<input name="agenda" value="${esc(cfg.agenda)}" placeholder="ex.: temos datas disponíveis na próxima semana">
<label>Etiqueta que também dispara a cobrança</label>
<input name="proposta_etiqueta" value="${esc(cfg.proposta_etiqueta)}" placeholder="opcional, ex.: proposta-enviada">
<small>O disparo principal é o PDF da proposta (nome como PE09-184 ou PC10-001) enviado pela atendente.</small>
<button type="submit">Salvar</button> <button type="submit" name="acao" value="testar" style="background:#44546a">Salvar e testar conexão com o Bradial</button>
</form>`,
  );
}

function autorizado(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ') || !PRONTO) return false;
  const txt = Buffer.from(h.slice(6), 'base64').toString('utf8');
  return igual(txt.slice(txt.indexOf(':') + 1), SENHA_PAINEL);
}

// Formulários só são aceitos quando partem da própria página (proteção contra envio forjado por outro site).
function mesmaOrigem(req) {
  const origem = req.headers.origin || req.headers.referer || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  try {
    return new URL(origem).host === host;
  } catch {
    return false;
  }
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const enviar = (status, corpo, tipo = 'application/json') => {
    res.writeHead(status, { 'content-type': `${tipo}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
    res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
  };
  const pedirSenha = () => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Detecta Cobranca", charset="UTF-8"' });
    res.end('Senha necessária');
  };
  try {
    const rota = url.pathname.replace(/\/+$/, '') || BASE;

    if (req.method === 'GET' && rota === `${BASE}/saude`) {
      return enviar(200, { ok: PRONTO && !!cfg.bradial_chave, configurado: !!cfg.bradial_chave, modo: cfg.modo });
    }

    if (req.method === 'POST' && (rota === `${BASE}/webhook` || rota.startsWith(`${BASE}/webhook/`))) {
      if (!PRONTO) return enviar(503, { erro: 'serviço não configurado' });
      const noCaminho = rota.slice(`${BASE}/webhook/`.length);
      if (!igual(req.headers['x-webhook-secret'], SEGREDO) && !igual(noCaminho, SEGREDO)) return enviar(401, { erro: 'não autorizado' });
      const corpo = await lerCorpo(req);
      let payload;
      try {
        payload = JSON.parse(corpo);
      } catch {
        return enviar(400, { erro: 'JSON inválido' });
      }
      db.run('INSERT INTO eventos_brutos (em, evento, corpo) VALUES (?,?,?)', Date.now(), String(payload.event || ''), corpo.slice(0, 20_000));
      const resultado = await motor.receberEvento(payload);
      return enviar(200, { ok: true, resultado });
    }

    if (rota === BASE || rota === `${BASE}/painel`) {
      if (!autorizado(req)) return pedirSenha();
      return enviar(200, painel(), 'text/html');
    }

    if (rota === `${BASE}/configurar`) {
      if (!autorizado(req)) return pedirSenha();
      if (req.method === 'GET') return enviar(200, configurar(req), 'text/html');
      if (req.method === 'POST') {
        if (!mesmaOrigem(req)) return enviar(403, { erro: 'origem inválida' });
        const form = new URLSearchParams(await lerCorpo(req, 50_000));
        const salvar = (k, v) => db.run('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', k, v);
        for (const k of ['somente_telefones', 'caixas', 'feriados', 'agenda', 'proposta_etiqueta', 'dias_uteis']) {
          if (form.has(k)) salvar(k, form.get(k).trim().slice(0, 500));
        }
        for (const k of ['horario_inicio', 'horario_fim']) {
          const v = (form.get(k) || '').trim();
          if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) salvar(k, v);
        }
        for (const k of ['bradial_chave', 'ia_chave']) {
          const v = (form.get(k) || '').trim();
          if (v) salvar(k, v.slice(0, 300)); // em branco mantém a chave atual
        }
        salvar('modo', form.get('modo') === 'auto' ? 'auto' : 'sombra');
        montar();
        let aviso = '<p class="ok">Configuração salva.</p>';
        if (form.get('acao') === 'testar') {
          try {
            const r = await bradial.caixas();
            const itens = Array.isArray(r) ? r : r?.data || r?.payload || r?.items || [];
            const nomes = itens.map((i) => `${i.name} (ID ${i.id})`).join(', ');
            aviso = `<p class="ok">Configuração salva. Conexão com o Bradial funcionando.${nomes ? ' Caixas de entrada: ' + esc(nomes) : ''}</p>`;
          } catch (e) {
            aviso = `<p class="erro">Configuração salva, mas a conexão com o Bradial falhou: ${esc(e.message)}</p>`;
          }
        }
        return enviar(200, configurar(req, aviso), 'text/html');
      }
    }

    // Diagnóstico: últimos eventos recebidos (mesma senha do painel).
    if (req.method === 'GET' && rota === `${BASE}/eventos`) {
      if (!autorizado(req)) return pedirSenha();
      return enviar(200, db.all('SELECT id, em, evento, corpo FROM eventos_brutos ORDER BY id DESC LIMIT 20'));
    }

    enviar(404, { erro: 'não encontrado' });
  } catch (e) {
    console.error('[erro]', e);
    if (!res.headersSent) enviar(500, { erro: 'erro interno' });
  }
});

servidor.listen(PORTA, () => {
  console.log(`[cobranca] porta ${PORTA} | modo=${cfg.modo} | envio ${cfg.horario_inicio}-${cfg.horario_fim} | Bradial=${cfg.bradial_chave ? 'ok' : 'SEM CHAVE'} | IA=${cfg.ia_chave ? 'ligada' : 'texto padrão'}`);
});

let rodando = false;
async function ciclo() {
  if (rodando || !PRONTO || !cfg.bradial_chave) return; // sem chave, só acumula histórico
  rodando = true;
  try {
    await motor.tick();
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    rodando = false;
  }
}
setInterval(ciclo, 60_000);
setInterval(() => motor.limparAntigos(), 6 * 3_600_000);
setTimeout(ciclo, 5_000);

for (const sinal of ['SIGTERM', 'SIGINT']) process.on(sinal, () => servidor.close(() => process.exit(0)));
