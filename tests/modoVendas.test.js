// modoVendas.test.js — o MODO VENDAS (V8): a liquidação da carteira.
//
// O que estes testes guardam: este é o segundo (e último) caminho do sistema
// capaz de vender no prejuízo, e o único em que quem decide é a IA. A regra
// imutável 4 do CLAUDE.md continua valendo em todo o resto — então mais da
// metade dos casos abaixo existe para provar que, com o modo DESLIGADO, nada
// mudou, e que a tolerância nunca nasce de decisão da IA.
// Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  avaliar,
  estadoModoVendas,
  perdaToleradaPosicao,
  MODO_VENDAS_DIAS_PADRAO,
  MODO_VENDAS_PERDA_MAXIMA_PADRAO,
} from '../src/regras/regrasEngine.js';
import { montarPromptSistema } from '../src/ia/montadorPrompt.js';
import { deveSupervisionar } from '../src/nucleo/supervisor.js';
import { formatarModoVendas, notificarModoVendas, limparAntiSpam } from '../src/notificacoes/telegram.js';

const CONFIG = {
  percentual_max_diferenca_execucao: 1.0,
  taxa_compra_percentual: 1.5,
  taxa_venda_percentual: 1.5,
  minimo_ordem_valor: 10,
  minimo_ordem_quantidade: 0.00001,
  orcamento_percentual: 100,
};

const DESDE = '2026-08-01T12:00:00Z';
const emDias = (n) => new Date(Date.parse(DESDE) + n * 86_400_000);
const controle = (extra = {}) => ({ modo_vendas: true, modo_vendas_desde: DESDE, ...extra });

const posicao = (extra = {}) => ({
  id: 'pos_a',
  status: 'MONITORANDO',
  origem: 'bot',
  quantidade: 0.01,
  preco_compra: 340000,
  ...extra,
});

const venda = (preco_execucao, { posicoes_abertas = [posicao()], ids = ['pos_a'], modo_vendas = null, saldo_ativo = 0.02 } = {}) => ({
  decisao: { acao: 'VENDER', percentual: 0, posicoes: ids, valida: true },
  carteira: { saldo_moeda: 0, saldo_ativo },
  posicoes_abertas,
  preco_analise: preco_execucao,
  preco_execucao,
  ordens_abertas: [],
  config: CONFIG,
  modo_vendas,
});

// =====================================================================
// A rampa: função pura do relógio, nunca da IA
// =====================================================================

test('modo desligado é null — e null é o que mantém a regra 4 intacta', () => {
  assert.equal(estadoModoVendas(null), null);
  assert.equal(estadoModoVendas({}), null);
  assert.equal(estadoModoVendas({ modo_vendas: false }), null);
  // Nem "quase true" liga: só o booleano exato.
  assert.equal(estadoModoVendas({ modo_vendas: 'sim' }), null);
});

test('a tolerância é ZERO no dia 1 — o dia inteiro, não só o primeiro instante', () => {
  for (const h of [0, 1, 12, 23.9]) {
    const e = estadoModoVendas(controle(), new Date(Date.parse(DESDE) + h * 3_600_000));
    assert.equal(e.dia, 1, `${h}h deveria ser o dia 1`);
    assert.equal(e.perda_maxima_percentual, 0, `${h}h deveria ter tolerância zero`);
  }
});

test('a tolerância abre em degraus iguais até o teto no último dia da janela', () => {
  const teto = MODO_VENDAS_PERDA_MAXIMA_PADRAO;
  const degrau = teto / (MODO_VENDAS_DIAS_PADRAO - 1);
  for (let dia = 1; dia <= MODO_VENDAS_DIAS_PADRAO; dia++) {
    const e = estadoModoVendas(controle(), emDias(dia - 1));
    assert.equal(e.dia, dia);
    assert.ok(
      Math.abs(e.perda_maxima_percentual - degrau * (dia - 1)) < 0.01,
      `dia ${dia}: ${e.perda_maxima_percentual}% (esperado ~${(degrau * (dia - 1)).toFixed(2)}%)`,
    );
  }
  assert.equal(estadoModoVendas(controle(), emDias(6)).perda_maxima_percentual, teto);
});

test('passada a janela a tolerância FICA no teto — nunca passa dele', () => {
  // O modo não expira sozinho (decisão do dono): a rampa vira platô, não rampa
  // infinita. Sem o teto, um mês esquecido ligado autorizaria qualquer prejuízo.
  for (const dia of [7, 30, 365]) {
    assert.equal(estadoModoVendas(controle(), emDias(dia)).perda_maxima_percentual, MODO_VENDAS_PERDA_MAXIMA_PADRAO);
  }
});

test('teto e janela são configuráveis, e valores inválidos caem no padrão', () => {
  const custom = controle({ modo_vendas_dias: 3, modo_vendas_perda_maxima_percentual: 30 });
  assert.equal(estadoModoVendas(custom, emDias(0)).perda_maxima_percentual, 0);
  assert.equal(estadoModoVendas(custom, emDias(1)).perda_maxima_percentual, 15);
  assert.equal(estadoModoVendas(custom, emDias(2)).perda_maxima_percentual, 30);

  const lixo = controle({ modo_vendas_dias: 'muitos', modo_vendas_perda_maxima_percentual: 'tudo' });
  const e = estadoModoVendas(lixo, emDias(0));
  assert.equal(e.dias_totais, MODO_VENDAS_DIAS_PADRAO);
  assert.equal(estadoModoVendas(lixo, emDias(99)).perda_maxima_percentual, MODO_VENDAS_PERDA_MAXIMA_PADRAO);
});

test('sem data de início a rampa RECOMEÇA do zero (nunca abre tudo de uma vez)', () => {
  // Flag ligado à mão no banco, sem `modo_vendas_desde`: o modo vale, mas o dia
  // 1 é hoje. O contrário — assumir tolerância cheia por falta de um campo —
  // seria a falha mais cara possível.
  const e = estadoModoVendas({ modo_vendas: true }, emDias(50));
  assert.equal(e.dia, 1);
  assert.equal(e.perda_maxima_percentual, 0);
});

test('a tolerância em dinheiro é percentual do CUSTO daquele lote', () => {
  const modo = estadoModoVendas(controle(), emDias(6)); // teto: 15%
  // custo = 0,01 × 340.000 = 3.400 → 15% = 510
  assert.ok(Math.abs(perdaToleradaPosicao(modo, posicao()) - 510) < 1e-9);
  // Lote maior tolera mais em dinheiro, mesmo percentual.
  assert.ok(Math.abs(perdaToleradaPosicao(modo, posicao({ quantidade: 0.02 })) - 1020) < 1e-9);
  // Modo desligado ou dia 1: zero, sempre.
  assert.equal(perdaToleradaPosicao(null, posicao()), 0);
  assert.equal(perdaToleradaPosicao(estadoModoVendas(controle(), emDias(0)), posicao()), 0);
});

// =====================================================================
// O Motor: com o modo DESLIGADO nada mudou
// =====================================================================

test('modo desligado: venda no prejuízo continua rejeitada, como sempre', () => {
  const r = avaliar(venda(335000)); // abaixo do preço de compra
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /nunca vender no prejuízo/);
});

test('modo desligado: a ordem aprovada não carrega marcação de liquidação', () => {
  const r = avaliar(venda(360000));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.modo_vendas, null);
  assert.equal(r.ordem.venda_com_prejuizo, false);
  assert.equal(r.ordem.posicoes[0].venda_com_prejuizo, false);
});

test('modo desligado: COMPRAR segue passando pelas regras normais', () => {
  const r = avaliar({
    decisao: { acao: 'COMPRAR', percentual: 35, stop_loss: 340000, stop_loss_motivo: 'fundo', valida: true },
    carteira: { saldo_moeda: 5000, saldo_ativo: 0 },
    preco_analise: 350000,
    preco_execucao: 350000,
    ordens_abertas: [],
    config: CONFIG,
  });
  assert.equal(r.status, 'aprovada');
});

// =====================================================================
// O Motor: com o modo LIGADO
// =====================================================================

test('COMPRAR é bloqueado durante a liquidação, por mais convincente que seja', () => {
  const r = avaliar({
    decisao: { acao: 'COMPRAR', percentual: 35, stop_loss: 340000, stop_loss_motivo: 'fundo', valida: true },
    carteira: { saldo_moeda: 5000, saldo_ativo: 0 },
    preco_analise: 350000,
    preco_execucao: 350000,
    ordens_abertas: [],
    config: CONFIG,
    modo_vendas: estadoModoVendas(controle(), emDias(0)),
  });
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /modo vendas ligado/);
  assert.match(r.motivo, /compras bloqueadas/);
});

test('dia 1: mesmo com o modo ligado, prejuízo NENHUM passa', () => {
  // A tolerância zero do primeiro dia é o que impede a IA de despejar a
  // carteira no pior preço assim que o dono liga o modo.
  const r = avaliar(venda(335000, { modo_vendas: estadoModoVendas(controle(), emDias(0)) }));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /tolerância do dia 1/);
});

test('no fim da janela, prejuízo DENTRO da tolerância é aprovado e marcado', () => {
  const modo = estadoModoVendas(controle(), emDias(6)); // 15% de 3.400 = 510
  // 336.000: prejuízo líquido ~ -95 (dentro dos 510 tolerados)
  const r = avaliar(venda(336000, { modo_vendas: modo }));
  assert.equal(r.status, 'aprovada');
  assert.ok(r.ordem.lucro_liquido_previsto < 0, 'a ordem sai no vermelho');
  assert.equal(r.ordem.venda_com_prejuizo, true);
  assert.equal(r.ordem.posicoes[0].venda_com_prejuizo, true);
  assert.equal(r.ordem.modo_vendas.dia, 7);
  assert.match(r.motivo, /no prejuízo \(modo vendas/);
});

test('prejuízo ACIMA da tolerância continua rejeitado — o teto é teto', () => {
  const modo = estadoModoVendas(controle(), emDias(6));
  // 280.000 → prejuízo de ~-620, acima dos 510 tolerados
  const r = avaliar(venda(280000, { modo_vendas: modo }));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /acima da tolerância/);
});

test('a tolerância é POR POSIÇÃO: o lote afundado é descartado, os outros saem', () => {
  const modo = estadoModoVendas(controle(), emDias(6));
  const abertas = [
    posicao({ id: 'pos_lucro', preco_compra: 300000 }),
    posicao({ id: 'pos_pouco', preco_compra: 340000 }), // dentro da tolerância
    posicao({ id: 'pos_afundado', preco_compra: 900000 }), // muito fora
  ];
  const r = avaliar(venda(336000, { posicoes_abertas: abertas, ids: ['pos_lucro', 'pos_pouco', 'pos_afundado'], modo_vendas: modo, saldo_ativo: 0.05 }));
  assert.equal(r.status, 'aprovada');
  assert.deepEqual(r.ordem.posicoes.map((p) => p.id), ['pos_lucro', 'pos_pouco']);
  assert.equal(r.ordem.posicoes_descartadas[0].id, 'pos_afundado');
  // O lote lucrativo NÃO é marcado como prejuízo só porque outro foi.
  assert.equal(r.ordem.posicoes[0].venda_com_prejuizo, false);
  assert.equal(r.ordem.posicoes[1].venda_com_prejuizo, true);
});

test('venda com lucro durante a liquidação NÃO é marcada como prejuízo', () => {
  const r = avaliar(venda(360000, { modo_vendas: estadoModoVendas(controle(), emDias(6)) }));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.venda_com_prejuizo, false);
  assert.equal(r.ordem.modo_vendas.dia, 7); // a marcação da janela fica, para auditoria
});

// =====================================================================
// O prompt
// =====================================================================

const manifest = { id: 'BTC', nome: 'Bitcoin', tipo: 'crypto', par: 'BTC-BRL', plataforma: 'MB' };
const camadas = {
  regrasGerais: { conteudo: '# Regras normais\nCompre na correção.', versao: 3 },
  regrasGeraisVenda: { conteudo: '# Regras de liquidação\nEncerre as posições.', versao: 1 },
  template: { conteudo: '# Template' },
  promptAtivo: { conteudo: 'nada' },
  supervisao: { conteudo: '## Geral\n- Camada do supervisor.', versao: 4 },
};

test('modo desligado: o prompt é exatamente o de sempre', () => {
  const p = montarPromptSistema({ manifest, ...camadas });
  assert.match(p.texto, /Regras normais/);
  assert.doesNotMatch(p.texto, /Regras de liquidação/);
  assert.match(p.texto, /Camada do supervisor/);
  assert.doesNotMatch(p.texto, /Liquidação em curso/);
});

test('modo ligado: as regras de liquidação SUBSTITUEM as normais (não somam)', () => {
  // Empilhar as duas entregaria à IA um prompt que manda comprar na correção e
  // liquidar tudo ao mesmo tempo — contradição custa qualidade de decisão.
  const p = montarPromptSistema({ manifest, ...camadas, modoVendas: estadoModoVendas(controle(), emDias(3)) });
  assert.match(p.texto, /Regras de liquidação/);
  assert.doesNotMatch(p.texto, /Regras normais/);
});

test('modo ligado: a camada do supervisor SAI do prompt', () => {
  // Ela audita decisões de ENTRADA; numa liquidação é ruído no melhor caso.
  const p = montarPromptSistema({ manifest, ...camadas, modoVendas: estadoModoVendas(controle(), emDias(3)) });
  assert.doesNotMatch(p.texto, /Camada do supervisor/);
});

test('modo ligado: o dia e a tolerância de hoje vão no prompt, em texto', () => {
  const p = montarPromptSistema({ manifest, ...camadas, modoVendas: estadoModoVendas(controle(), emDias(3)) });
  assert.match(p.texto, /Liquidação em curso/);
  assert.match(p.texto, /dia: 4 de 7/);
  assert.match(p.texto, /prejuízo máximo aceito HOJE por posição: 7\.5%/);
});

test('o CONTRATO_SAIDA continua sendo a última palavra, também na liquidação', () => {
  const p = montarPromptSistema({ manifest, ...camadas, modoVendas: estadoModoVendas(controle(), emDias(3)) });
  assert.equal(p.partes[p.partes.length - 1].startsWith('# Formato de saída'), true);
});

// =====================================================================
// O supervisor semanal fica pausado
// =====================================================================

test('o supervisor não roda durante a liquidação — nem pelo botão "rodar agora"', () => {
  const vencida = { gerado_em: '2026-01-01T00:00:00Z' }; // muito além dos 7 dias
  const modo = estadoModoVendas(controle(), emDias(1));

  const auto = deveSupervisionar({ supervisao: vencida, agora: emDias(1), modoVendas: modo });
  assert.equal(auto.rodar, false);
  assert.match(auto.motivo, /modo vendas/);

  // O botão adianta a rodada; ele não muda o que a rodada É.
  const manual = deveSupervisionar({ supervisao: vencida, agora: emDias(1), forcar: true, modoVendas: modo });
  assert.equal(manual.rodar, false);
  assert.match(manual.motivo, /modo vendas/);
});

test('desligado o modo, o supervisor volta exatamente de onde estava', () => {
  // Nada foi apagado: a régua continua sendo o `gerado_em` persistido.
  const vencida = { gerado_em: '2026-01-01T00:00:00Z' };
  assert.equal(deveSupervisionar({ supervisao: vencida, forcar: true, modoVendas: null }).rodar, true);
  const recente = { gerado_em: emDias(0).toISOString() };
  assert.equal(deveSupervisionar({ supervisao: recente, agora: emDias(1), modoVendas: null }).rodar, false);
});

// =====================================================================
// O aviso — porque o modo não expira sozinho
// =====================================================================

beforeEach(() => limparAntiSpam());

const cfgTelegram = { token_configurado: true, chat_id: '123', ativo: true };
const envSemFallback = {};

test('o lembrete diz o dia, a tolerância e o que está bloqueado', () => {
  const t = formatarModoVendas(estadoModoVendas(controle(), emDias(3)));
  assert.match(t, /dia 4 de 7/);
  assert.match(t, /7\.5%/);
  assert.match(t, /Compras bloqueadas/);
});

test('passada a janela, o lembrete COBRA o desligamento', () => {
  const t = formatarModoVendas(estadoModoVendas(controle(), emDias(20)));
  assert.match(t, /janela planejada terminou/);
  assert.match(t, /continua ligado/);
});

test('o lembrete sai UMA vez por dia, não a cada tick', async () => {
  const enviadas = [];
  const fetchFn = async () => { enviadas.push(1); return { ok: true, json: async () => ({ ok: true }) }; };
  const estado = estadoModoVendas(controle(), emDias(3));
  const cfg = { ...cfgTelegram, bot_token: 'x' };

  const t0 = Date.parse('2026-08-04T12:00:00Z');
  await notificarModoVendas({ estado, config: cfg, fetchFn, agoraMs: t0 });
  await notificarModoVendas({ estado, config: cfg, fetchFn, agoraMs: t0 + 60_000 });
  await notificarModoVendas({ estado, config: cfg, fetchFn, agoraMs: t0 + 3_600_000 });
  assert.equal(enviadas.length, 1, 'um tick por minuto não pode virar um aviso por minuto');

  await notificarModoVendas({ estado, config: cfg, fetchFn, agoraMs: t0 + 25 * 3_600_000 });
  assert.equal(enviadas.length, 2, 'no dia seguinte o lembrete volta');
});

test('o aviso de DESLIGADO só sai se o modo estava ligado antes', async () => {
  const enviadas = [];
  const fetchFn = async () => { enviadas.push(1); return { ok: true, json: async () => ({ ok: true }) }; };
  const cfg = { ...cfgTelegram, bot_token: 'x' };

  // Bot que sobe com o modo desligado não anuncia "desligado" no boot.
  await notificarModoVendas({ estado: { ativo: false }, config: cfg, fetchFn });
  assert.equal(enviadas.length, 0);

  await notificarModoVendas({ estado: estadoModoVendas(controle(), emDias(1)), config: cfg, fetchFn });
  await notificarModoVendas({ estado: { ativo: false }, config: cfg, fetchFn });
  assert.equal(enviadas.length, 2, 'ligou e depois desligou: dois avisos');
});

test('avisar NUNCA lança, nem com o Telegram fora do ar', async () => {
  const fetchFn = async () => { throw new Error('rede caiu'); };
  const r = await notificarModoVendas({
    estado: estadoModoVendas(controle(), emDias(1)),
    config: { ...cfgTelegram, bot_token: 'x' },
    fetchFn,
  });
  assert.equal(r, false);
});

test('o toggle do evento desliga o lembrete sem desligar o modo', async () => {
  const enviadas = [];
  const fetchFn = async () => { enviadas.push(1); return { ok: true, json: async () => ({ ok: true }) }; };
  await notificarModoVendas({
    estado: estadoModoVendas(controle(), emDias(1)),
    config: { ...cfgTelegram, bot_token: 'x', eventos: { modo_vendas: false } },
    fetchFn,
  });
  assert.equal(enviadas.length, 0);
  assert.equal(envSemFallback.nada, undefined);
});
