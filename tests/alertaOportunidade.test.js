// alertaOportunidade.test.js — ALERTA DE OPORTUNIDADE (§10.12 do CLAUDE.md).
//
// Em plataforma ASSISTIDA a aprovação do Motor não vira ordem: vira um recado
// para o dono executar (ou não) à mão. Como nenhum dinheiro sai da conta, as
// regras que protegem o CAIXA saem do caminho — saldo, orçamento, mínimo de
// ordem e circuit breaker. **Todo o resto continua**, e o teste que mais
// importa aqui é o que prova que a regra imutável 4 NÃO foi afrouxada: nunca se
// recomenda vender no prejuízo, porque o recado empurra uma venda de verdade.
//
// O que motivou: a carteira da Toro tinha R$ 16 de caixa informado (um número
// que o DONO digita, não que o robô lê), e com ele nenhuma oportunidade de
// compra jamais chegaria à tela. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avaliar } from '../src/regras/regrasEngine.js';
import { formatarOperacao } from '../src/notificacoes/telegram.js';

const CONFIG = {
  percentual_max_diferenca_execucao: 1,
  taxa_compra_percentual: 0.03,
  taxa_venda_percentual: 0.03,
  minimo_ordem_valor: 1,
  minimo_ordem_quantidade: 1,
  orcamento_percentual: 42,
  limite_perda_diaria_percentual: 3,
  stop_loss_max_distancia_percentual: 25,
  stop_loss_trailing_percentual: 3,
};

const COMPRAR = {
  acao: 'COMPRAR',
  percentual: 20,
  justificativa: 'FII descontado sobre o valor patrimonial.',
  stop_loss: 8.5,
  stop_loss_motivo: 'abaixo do fundo de 12 meses',
};

const base = (extra = {}) => ({
  decisao: COMPRAR,
  carteira: { saldo_moeda: 16, saldo_ativo: 245 },
  preco_analise: 9.4,
  preco_execucao: 9.4,
  ordens_abertas: [],
  config: CONFIG,
  patrimonio_plataforma: 5400,
  // A Toro real: o orçamento do ativo é o peso que ele JÁ tem, então o
  // "orçamento livre" é zero — mais um caminho que calaria o alerta.
  valor_posicoes_ativo: 2268,
  ...extra,
});

// ------------------------------------------------------- o problema, e o conserto

test('sem o alerta, o caixa de R$ 16 rejeita a compra (comportamento de ordem)', () => {
  const r = avaliar(base());
  assert.equal(r.status, 'rejeitada_saldo');
  assert.equal(r.aprovada, false);
});

test('com o alerta, a mesma decisão é APROVADA e não tem tamanho', () => {
  const r = avaliar(base({ recomendacao: true }));
  assert.equal(r.aprovada, true);
  assert.equal(r.ordem.tipo, 'COMPRA');
  assert.equal(r.ordem.valor, null, 'quanto comprar é decisão de quem executa');
  assert.equal(r.ordem.percentual_ia, 20, 'a fatia sugerida pela IA viaja como texto');
  assert.equal(r.ordem.recomendacao, true);
});

test('alerta: orçamento livre ZERO não cala mais a oportunidade', () => {
  const r = avaliar(base({ recomendacao: true, valor_posicoes_ativo: 999999 }));
  assert.equal(r.aprovada, true);
});

test('alerta: orçamento 0% também não cala — ele é regra de tamanho, não de mérito', () => {
  const r = avaliar(base({ recomendacao: true, config: { ...CONFIG, orcamento_percentual: 0 } }));
  assert.equal(r.aprovada, true);
});

test('alerta: caixa ZERO não cala a oportunidade', () => {
  const r = avaliar(base({ recomendacao: true, carteira: { saldo_moeda: 0, saldo_ativo: 245 } }));
  assert.equal(r.aprovada, true);
});

test('alerta: o circuit breaker não bloqueia — dia de queda é quando a oportunidade aparece', () => {
  // −7,4% no dia. Com caixa de sobra, para a rejeição ser mesmo a do breaker
  // (o item 1 vem antes na ordem oficial e mascararia o caso).
  const comQueda = {
    patrimonio_atual: 5000,
    patrimonio_inicio_dia: 5400,
    carteira: { saldo_moeda: 5000, saldo_ativo: 0 },
    valor_posicoes_ativo: 0,
  };
  const naOrdem = avaliar(base(comQueda));
  assert.equal(naOrdem.status, 'rejeitada_regras', 'na ORDEM ele continua bloqueando');
  assert.match(naOrdem.motivo, /circuit breaker/);
  assert.equal(avaliar(base({ ...comQueda, recomendacao: true })).aprovada, true);
});

// ------------------------------------------ o que o alerta NÃO afrouxa

test('REGRA IMUTÁVEL 4: nunca se RECOMENDA vender no prejuízo', () => {
  const posicoes = [{ id: 'pos_1', status: 'ABERTA', quantidade: 245, preco_compra: 9.39 }];
  const r = avaliar(
    base({
      recomendacao: true,
      decisao: { acao: 'VENDER', posicoes: ['pos_1'], percentual: 0, justificativa: 'saída' },
      posicoes_abertas: posicoes,
      preco_analise: 8.9,
      preco_execucao: 8.9, // abaixo do custo: prejuízo
    }),
  );
  assert.equal(r.aprovada, false);
  assert.equal(r.status, 'rejeitada_regras');
});

test('a venda RECOMENDADA com lucro continua passando normalmente', () => {
  const posicoes = [{ id: 'pos_1', status: 'ABERTA', quantidade: 245, preco_compra: 9.0 }];
  const r = avaliar(
    base({
      recomendacao: true,
      decisao: { acao: 'VENDER', posicoes: ['pos_1'], percentual: 0, justificativa: 'realizar' },
      posicoes_abertas: posicoes,
      preco_analise: 10,
      preco_execucao: 10,
    }),
  );
  assert.equal(r.aprovada, true);
  assert.equal(r.ordem.tipo, 'VENDA');
  assert.equal(r.ordem.quantidade, 245, 'a VENDA tem tamanho: são os lotes que existem de verdade');
});

test('alerta: o stop-loss declarado continua obrigatório e validado', () => {
  const semChao = { ...COMPRAR, stop_loss: 99 }; // acima do preço
  const r = avaliar(base({ recomendacao: true, decisao: semChao }));
  assert.equal(r.aprovada, false);
  assert.match(r.motivo, /stop-loss/i);
});

test('alerta: preço divergente e ordem aberta continuam bloqueando', () => {
  assert.equal(
    avaliar(base({ recomendacao: true, preco_execucao: 12 })).status,
    'rejeitada_regras',
    'divergência de preço não tem nada a ver com caixa',
  );
  assert.equal(
    avaliar(base({ recomendacao: true, ordens_abertas: [{ id: 'x' }] })).status,
    'rejeitada_regras',
  );
});

test('a plataforma que EXECUTA não muda em nada (o contrato de sempre)', () => {
  const r = avaliar(base({ carteira: { saldo_moeda: 5000, saldo_ativo: 0 }, valor_posicoes_ativo: 0 }));
  assert.equal(r.aprovada, true);
  // A base é min(caixa 5.000, orçamento livre 42% de 5.400 = 2.268) e o
  // percentual da IA aplica sobre ELA — nunca sobre o caixa total.
  assert.equal(r.ordem.valor, 453.6, '20% de 2.268 — a conta de sempre, em centavos exatos');
  assert.equal(r.ordem.percentual_ia, null);
  assert.equal(r.ordem.recomendacao, false);
});

// ------------------------------------------------------------- o aviso

test('Telegram: alerta sem tamanho não promete total nenhum', () => {
  const texto = formatarOperacao({
    plataformaId: 'TORO',
    ativoId: 'FIIR11',
    operacao: {
      status: 'sugerida',
      tipo: 'COMPRA',
      preco: 9.4,
      quantidade: null,
      valor: null,
      percentual_sugerido: 20,
      justificativa_ia: 'desconto sobre o valor patrimonial',
    },
    moeda: 'BRL',
  });
  assert.match(texto, /Oportunidade/);
  assert.match(texto, /20%/);
  assert.match(texto, /não envia ordem/);
  assert.doesNotMatch(texto, /Total:/, 'um total inventado é pior que nenhum total');
});

test('Telegram: recomendação COM tamanho (venda de lotes) continua como era', () => {
  const texto = formatarOperacao({
    plataformaId: 'TORO',
    ativoId: 'FIIR11',
    operacao: { status: 'sugerida', tipo: 'VENDA', preco: 10, quantidade: 245, valor: 2450 },
    moeda: 'BRL',
  });
  assert.match(texto, /execute na corretora/);
  assert.match(texto, /Total:/);
});
