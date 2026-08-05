// telegram.test.js — avisos do Telegram (V7, parte 1).
//
// O contrato mais importante deste módulo é NEGATIVO: notificação nunca pode
// quebrar o robô. Por isso boa parte dos testes verifica que ele engole falhas
// e devolve false, em vez de lançar. Nenhum teste toca a rede (fetch injetado).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolverConfig,
  escaparHTML,
  formatarOperacao,
  eventoDaOperacao,
  enviarMensagem,
  notificarOperacao,
  notificarProblema,
  notificarRecuperacao,
  limparAntiSpam,
  confirmarAtivacao,
  limparAtivacao,
  ultimoResultadoEnvio,
  limparUltimoEnvio,
  INTERVALO_ANTISPAM_MS,
} from '../src/notificacoes/telegram.js';

const CFG = { bot_token: 'tok', chat_id: '123' };
const SEM_ENV = {};

/** fetch falso que registra as chamadas e responde OK. */
function fetchFalso({ ok = true, status = 200 } = {}) {
  const chamadas = [];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    return { ok, status };
  };
  fn.chamadas = chamadas;
  return fn;
}

// ------------------------------------------------------------- configuração

test('sem token ou sem chat não há como notificar', () => {
  assert.equal(resolverConfig(null, SEM_ENV), null);
  assert.equal(resolverConfig({ bot_token: 'tok' }, SEM_ENV), null);
  assert.equal(resolverConfig({ chat_id: '1' }, SEM_ENV), null);
});

test('config do Firestore tem prioridade; .env é o fallback de desenvolvimento', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'do-env', TELEGRAM_CHAT_ID: '999' };
  assert.equal(resolverConfig(null, env).token, 'do-env');
  assert.equal(resolverConfig(CFG, env).token, 'tok');
});

test('ativo: false desliga tudo, mas ausente significa ligado', () => {
  assert.equal(resolverConfig({ ...CFG, ativo: false }, SEM_ENV), null);
  assert.ok(resolverConfig(CFG, SEM_ENV));
});

test('cada evento pode ser desligado; ausente = ligado', () => {
  const cfg = resolverConfig({ ...CFG, eventos: { compra: false } }, SEM_ENV);
  assert.equal(cfg.eventos.compra, false);
  assert.equal(cfg.eventos.venda, true);
  assert.equal(cfg.eventos.problema, true);
});

// ------------------------------------------------------------- formatação

test('escapa marcação HTML vinda de texto da IA', () => {
  assert.equal(escaparHTML('<b>a</b> & 1>0'), '&lt;b&gt;a&lt;/b&gt; &amp; 1&gt;0');
});

test('venda por STOP-LOSS é identificada e mostra o prejuízo', () => {
  const texto = formatarOperacao({
    plataformaId: 'MB',
    ativoId: 'BTC',
    moeda: 'BRL',
    operacao: {
      tipo: 'VENDA', status: 'executada', modo: 'real',
      quantidade: 0.001, preco: 332453, valor: 332.45, lucro_liquido: -54.8,
      origem_decisao: 'motor_stop_loss',
      stop_loss: [{ id: 'p', stop_loss: 333000, motivo: 'abaixo da MM50' }],
    },
  });
  assert.match(texto, /STOP-LOSS/);
  assert.match(texto, /-54\.80 BRL/);
  assert.match(texto, /abaixo da MM50/);
  assert.doesNotMatch(texto, /simulação/);
});

test('venda pela TRAVA DE LUCRO tem nome próprio — não se confunde com o stop (V8.11)', () => {
  // As duas são do Motor e as duas viram "venda" se ninguém as separar. Só que
  // uma protege de uma queda e a outra realiza um ganho: ler "venda" e não saber
  // qual das duas foi é perder a única informação que importa no aviso.
  const texto = formatarOperacao({
    plataformaId: 'TT',
    ativoId: 'NVDA',
    moeda: 'USD',
    operacao: {
      tipo: 'VENDA', status: 'executada', modo: 'simulacao',
      quantidade: 0.12, preco: 219.88, valor: 26.39, lucro_liquido: 2.95,
      origem_decisao: 'motor_trava_lucro',
    },
  });
  assert.match(texto, /TRAVA DE LUCRO/);
  assert.match(texto, /\+2\.95 USD/);
  assert.doesNotMatch(texto, /STOP-LOSS/);
});

test('venda normal com lucro leva o sinal de + e marca a simulação', () => {
  const texto = formatarOperacao({
    plataformaId: 'TT', ativoId: 'PBR', moeda: 'USD',
    operacao: { tipo: 'VENDA', status: 'executada', modo: 'simulacao', quantidade: 50, preco: 18.88, valor: 944, lucro_liquido: 47.77 },
  });
  assert.match(texto, /\+47\.77 USD/);
  assert.match(texto, /simulação/);
  assert.doesNotMatch(texto, /STOP-LOSS/);
});

test('recomendação da assistida diz o que fazer', () => {
  const texto = formatarOperacao({
    plataformaId: 'TORO', ativoId: 'MXRF11', moeda: 'BRL',
    operacao: { tipo: 'COMPRA', status: 'sugerida', quantidade: 100, preco: 9.6, valor: 960, justificativa_ia: 'RSI baixo.' },
  });
  assert.match(texto, /Recomendação/);
  assert.match(texto, /registre pela dashboard/);
});

test('rejeições e status irrelevantes não viram mensagem', () => {
  for (const status of ['rejeitada_saldo', 'rejeitada_regras', 'erro']) {
    assert.equal(
      formatarOperacao({ plataformaId: 'MB', ativoId: 'BTC', operacao: { tipo: 'COMPRA', status } }),
      null,
    );
  }
  assert.equal(formatarOperacao({ plataformaId: 'MB', ativoId: 'BTC', operacao: null }), null);
  // DIVIDENDO é informativo e não é uma operação de trading.
  assert.equal(
    formatarOperacao({ plataformaId: 'TORO', ativoId: 'MXRF11', operacao: { tipo: 'DIVIDENDO', status: 'executada' } }),
    null,
  );
});

test('cada operação cai no toggle certo', () => {
  assert.equal(eventoDaOperacao({ tipo: 'COMPRA', status: 'executada' }), 'compra');
  assert.equal(eventoDaOperacao({ tipo: 'VENDA', status: 'executada' }), 'venda');
  assert.equal(eventoDaOperacao({ tipo: 'COMPRA', status: 'sugerida' }), 'recomendacao');
});

// ------------------------------------------------------------------- envio

test('envia a mensagem com chat_id e HTML', async () => {
  const fetchFn = fetchFalso();
  const ok = await enviarMensagem('oi', { token: 'tok', chatId: '123' }, { fetchFn });
  assert.equal(ok, true);
  assert.match(fetchFn.chamadas[0].url, /\/bottok\/sendMessage$/);
  assert.equal(fetchFn.chamadas[0].corpo.chat_id, '123');
  assert.equal(fetchFn.chamadas[0].corpo.parse_mode, 'HTML');
});

test('CONTRATO: falha de rede NÃO lança — devolve false', async () => {
  const explode = async () => {
    throw new Error('rede caiu');
  };
  assert.equal(await enviarMensagem('oi', { token: 't', chatId: '1' }, { fetchFn: explode }), false);
});

test('CONTRATO: HTTP de erro (chat_id errado, bot bloqueado) não lança', async () => {
  const fetchFn = fetchFalso({ ok: false, status: 403 });
  assert.equal(await enviarMensagem('oi', { token: 't', chatId: '1' }, { fetchFn }), false);
});

test('evento desligado não gera envio', async () => {
  const fetchFn = fetchFalso();
  const enviou = await notificarOperacao({
    plataformaId: 'MB', ativoId: 'BTC',
    operacao: { tipo: 'COMPRA', status: 'executada', quantidade: 1, preco: 10, valor: 10 },
    config: { ...CFG, eventos: { compra: false } },
    fetchFn,
  });
  assert.equal(enviou, false);
  assert.equal(fetchFn.chamadas.length, 0);
});

test('sem configuração nenhuma, notificar é um no-op silencioso', async () => {
  const fetchFn = fetchFalso();
  assert.equal(
    await notificarOperacao({
      plataformaId: 'MB', ativoId: 'BTC',
      operacao: { tipo: 'COMPRA', status: 'executada', quantidade: 1, preco: 10, valor: 10 },
      config: null, fetchFn,
    }),
    false,
  );
  assert.equal(fetchFn.chamadas.length, 0);
});

// ------------------------------------------- resultado do último envio
// Caso real (2026-07-25): o id do PRÓPRIO bot foi colado no lugar do id do
// dono; o Telegram devolveu 403 "the bot can't send messages to the bot" e o
// erro morreu no log do pm2. A descrição precisa chegar à dashboard.

test('falha guarda a DESCRIÇÃO do Telegram, não só o código HTTP', async () => {
  limparUltimoEnvio();
  const fetchFn = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, description: "Forbidden: the bot can't send messages to the bot" }),
  });
  await enviarMensagem('oi', { token: 't', chatId: '1' }, { fetchFn });
  const r = ultimoResultadoEnvio();
  assert.equal(r.ok, false);
  assert.match(r.erro, /403/);
  assert.match(r.erro, /can't send messages to the bot/);
  assert.ok(r.em);
});

test('envio bem-sucedido registra ok', async () => {
  limparUltimoEnvio();
  await enviarMensagem('oi', { token: 't', chatId: '1' }, { fetchFn: fetchFalso() });
  assert.equal(ultimoResultadoEnvio().ok, true);
});

test('corpo de erro ilegível não quebra o registro', async () => {
  limparUltimoEnvio();
  const fetchFn = async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error('não é JSON');
    },
  });
  assert.equal(await enviarMensagem('oi', { token: 't', chatId: '1' }, { fetchFn }), false);
  assert.match(ultimoResultadoEnvio().erro, /500/);
});

// ---------------------------------------------- confirmação de ativação

test('confirma a ativação uma vez, e de novo se o chat id mudar', async () => {
  limparAtivacao();
  const fetchFn = fetchFalso();
  assert.equal(await confirmarAtivacao({ config: CFG, fetchFn }), true);
  assert.equal(await confirmarAtivacao({ config: CFG, fetchFn }), false); // já confirmou
  // Trocou o chat id (foi o caso real: id do bot → id do dono) → confirma de novo.
  assert.equal(await confirmarAtivacao({ config: { ...CFG, chat_id: '999' }, fetchFn }), true);
  assert.equal(fetchFn.chamadas.length, 2);
});

test('falha no envio NÃO marca a ativação como confirmada — tenta de novo', async () => {
  limparAtivacao();
  const falha = async () => ({ ok: false, status: 500, json: async () => ({ description: 'oops' }) });
  assert.equal(await confirmarAtivacao({ config: CFG, fetchFn: falha }), false);
  // Marcar antes do envio silenciaria a confirmação para sempre; ela é o teste
  // de configuração do usuário e precisa insistir enquanto não chegar.
  const ok = fetchFalso();
  assert.equal(await confirmarAtivacao({ config: CFG, fetchFn: ok }), true);
});

test('desligar os avisos rearma a confirmação', async () => {
  limparAtivacao();
  const fetchFn = fetchFalso();
  await confirmarAtivacao({ config: CFG, fetchFn });
  await confirmarAtivacao({ config: { ...CFG, ativo: false }, fetchFn }); // desligou
  assert.equal(await confirmarAtivacao({ config: CFG, fetchFn }), true); // religou: avisa
});

// --------------------------------------------------------------- anti-spam

test('problema avisa UMA vez por dia (quota volta a cada ciclo)', async () => {
  limparAntiSpam();
  const fetchFn = fetchFalso();
  const base = { chave: 'quota_ia:MB', titulo: 'Quota da IA esgotada', config: CFG, fetchFn };

  assert.equal(await notificarProblema({ ...base, agoraMs: 0 }), true);
  assert.equal(await notificarProblema({ ...base, agoraMs: 60_000 }), false);
  assert.equal(await notificarProblema({ ...base, agoraMs: INTERVALO_ANTISPAM_MS + 1 }), true);
  assert.equal(fetchFn.chamadas.length, 2);
});

test('a trava é POR CHAVE — uma plataforma não cala a outra', async () => {
  limparAntiSpam();
  const fetchFn = fetchFalso();
  await notificarProblema({ chave: 'conexao:MB', titulo: 'MB caiu', config: CFG, fetchFn, agoraMs: 0 });
  await notificarProblema({ chave: 'conexao:BN', titulo: 'BN caiu', config: CFG, fetchFn, agoraMs: 0 });
  assert.equal(fetchFn.chamadas.length, 2);
});

test('recuperação só avisa se havia episódio aberto, e rearma a trava', async () => {
  limparAntiSpam();
  const fetchFn = fetchFalso();
  const chave = 'conexao:MB';

  // Nada aberto (bot recém-iniciado): não anuncia "voltou" do nada.
  assert.equal(await notificarRecuperacao({ chave, titulo: 'voltou', config: CFG, fetchFn }), false);

  await notificarProblema({ chave, titulo: 'caiu', config: CFG, fetchFn, agoraMs: 0 });
  assert.equal(await notificarRecuperacao({ chave, titulo: 'voltou', config: CFG, fetchFn }), true);
  // Rearmada: um novo episódio avisa na hora, sem esperar 24 h.
  assert.equal(await notificarProblema({ chave, titulo: 'caiu de novo', config: CFG, fetchFn, agoraMs: 1000 }), true);
});
